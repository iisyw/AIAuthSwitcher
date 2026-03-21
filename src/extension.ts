import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

type JwtPayload = Record<string, unknown>;

type AuthFile = {
	auth_mode?: string;
	last_refresh?: string | null;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
};

type AccountSummary = {
	email: string | null;
	name: string | null;
	plan: string | null;
	accountId: string | null;
	userId: string | null;
	idTokenExpiresAt: string | null;
	accessTokenExpiresAt: string | null;
	lastRefresh: string | null;
};

type AuthBackupQuickPickItem = vscode.QuickPickItem & {
	authPath: string;
	isCurrent?: boolean;
	summary?: AccountSummary;
};

type ItemKind = 'section' | 'info' | 'action' | 'backup';

class AIAuthSwitcherItem extends vscode.TreeItem {
	constructor(
		public readonly kind: ItemKind,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly children: AIAuthSwitcherItem[] = [],
		public readonly authPath?: string
	) {
		super(label, collapsibleState);
	}
}

class AIAuthSwitcherViewProvider implements vscode.TreeDataProvider<AIAuthSwitcherItem> {
	private readonly changeEmitter = new vscode.EventEmitter<AIAuthSwitcherItem | undefined | void>();
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	refresh(): void {
		this.changeEmitter.fire();
	}

	async getChildren(element?: AIAuthSwitcherItem): Promise<AIAuthSwitcherItem[]> {
		if (element) {
			return element.children;
		}

		const currentAccountSection = await this.buildCurrentAccountSection();
		const actionsSection = this.buildActionsSection();
		const backupsSection = await this.buildBackupsSection();
		return [currentAccountSection, actionsSection, backupsSection];
	}

	getTreeItem(element: AIAuthSwitcherItem): vscode.TreeItem {
		return element;
	}

	private async buildCurrentAccountSection(): Promise<AIAuthSwitcherItem> {
		try {
			const summary = await readCurrentAccountSummary();
			const section = new AIAuthSwitcherItem(
				'section',
				'Current Account',
				vscode.TreeItemCollapsibleState.Expanded,
				[
					createInfoItem('Email', summary.email ?? 'unknown'),
					createInfoItem('Name', summary.name ?? 'unknown'),
					createInfoItem('Plan', summary.plan ?? 'unknown'),
					createInfoItem('Account ID', summary.accountId ?? 'unknown'),
					createInfoItem('User ID', summary.userId ?? 'unknown'),
					createInfoItem('ID Token Expires', summary.idTokenExpiresAt ?? 'unknown'),
					createInfoItem('Access Token Expires', summary.accessTokenExpiresAt ?? 'unknown'),
					createInfoItem('Last Refresh', summary.lastRefresh ?? 'unknown'),
				]
			);
			section.description = summary.email ?? 'unknown';
			section.iconPath = new vscode.ThemeIcon('account');
			return section;
		} catch (error) {
			const section = new AIAuthSwitcherItem(
				'section',
				'Current Account',
				vscode.TreeItemCollapsibleState.Expanded,
				[createInfoItem('Error', error instanceof Error ? error.message : String(error))]
			);
			section.iconPath = new vscode.ThemeIcon('warning');
			return section;
		}
	}

	private buildActionsSection(): AIAuthSwitcherItem {
		const actions = [
			createActionItem('Backup Current Auth', 'ai-auth-switcher.backupCurrentAuth', 'archive'),
			createActionItem('Reload Target Extension', 'ai-auth-switcher.reloadTargetExtension', 'sync'),
		];

		const section = new AIAuthSwitcherItem(
			'section',
			'Actions',
			vscode.TreeItemCollapsibleState.Expanded,
			actions
		);
		section.iconPath = new vscode.ThemeIcon('tools');
		return section;
	}

	private async buildBackupsSection(): Promise<AIAuthSwitcherItem> {
		const backupDir = await ensureBackupDirectory(this.context);
		const entries = await listBackupFiles(backupDir);
		const children =
			entries.length > 0
				? entries.map((entry) => createBackupItem(entry))
				: [createInfoItem('Status', 'No backups yet')];
		const section = new AIAuthSwitcherItem(
			'section',
			'Backups',
			vscode.TreeItemCollapsibleState.Expanded,
			children
		);
		section.description = `${entries.length}`;
		section.iconPath = new vscode.ThemeIcon('files');
		return section;
	}
}

const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
let aiAuthSwitcherViewProvider: AIAuthSwitcherViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	aiAuthSwitcherViewProvider = new AIAuthSwitcherViewProvider(context);

	const treeView = vscode.window.createTreeView('ai-auth-switcher.accountsView', {
		treeDataProvider: aiAuthSwitcherViewProvider,
		showCollapseAll: false,
	});

	const commands = [
		treeView,
		vscode.commands.registerCommand('ai-auth-switcher.showCurrentAccount', async () => {
			await showCurrentAccount();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.backupCurrentAuth', async () => {
			await backupCurrentAuth(context);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.reloadTargetExtension', async () => {
			await reloadTargetExtension();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.refreshView', async () => {
			aiAuthSwitcherViewProvider?.refresh();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.restoreBackupItem', async (target?: string | AIAuthSwitcherItem) => {
			await restoreBackupPath(context, resolveAuthPath(target));
		}),
		vscode.commands.registerCommand('ai-auth-switcher.deleteBackupItem', async (target?: string | AIAuthSwitcherItem) => {
			await deleteBackupPath(resolveAuthPath(target));
		}),
	];

	context.subscriptions.push(...commands);
}

export function deactivate() {}

async function showCurrentAccount(): Promise<void> {
	try {
		const summary = await readCurrentAccountSummary();
		const lines = [
			`Email: ${summary.email ?? 'unknown'}`,
			`Name: ${summary.name ?? 'unknown'}`,
			`Plan: ${summary.plan ?? 'unknown'}`,
			`Account ID: ${summary.accountId ?? 'unknown'}`,
			`User ID: ${summary.userId ?? 'unknown'}`,
			`ID Token Expires: ${summary.idTokenExpiresAt ?? 'unknown'}`,
			`Access Token Expires: ${summary.accessTokenExpiresAt ?? 'unknown'}`,
			`Last Refresh: ${summary.lastRefresh ?? 'unknown'}`,
			`Auth File: ${CODEX_AUTH_PATH}`,
		];

		const doc = await vscode.workspace.openTextDocument({
			content: lines.join('\n'),
			language: 'text',
		});
		await vscode.window.showTextDocument(doc, { preview: true });
	} catch (error) {
		await showError('Failed to read current Codex account.', error);
	}
}

async function backupCurrentAuth(context: vscode.ExtensionContext): Promise<void> {
	try {
		const auth = await readAuthFile(CODEX_AUTH_PATH);
		const summary = summarizeAuth(auth);
		const backupDir = await ensureBackupDirectory(context);
		const existingBackupPath = await findMatchingBackup(backupDir, auth);
		const backupPath = existingBackupPath ?? path.join(backupDir, buildBackupFileName(summary));
		const wasOverwrite = Boolean(existingBackupPath);

		await fs.copyFile(CODEX_AUTH_PATH, backupPath);
		aiAuthSwitcherViewProvider?.refresh();

		const action = 'Show Current Account';
		const picked = await vscode.window.showInformationMessage(
			wasOverwrite
				? `Updated existing backup ${path.basename(backupPath)}.`
				: `Auth backed up to ${path.basename(backupPath)}.`,
			action
		);

		if (picked === action) {
			await showCurrentAccount();
		}
	} catch (error) {
		await showError('Failed to back up current auth.', error);
	}
}

async function restoreBackupPath(context: vscode.ExtensionContext, authPath: string | null): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('No backup path was provided for restore.');
			return;
		}

		const backupDir = await ensureBackupDirectory(context);
		const currentAuth = await readAuthFile(CODEX_AUTH_PATH);
		const currentSummary = summarizeAuth(currentAuth);
		const targetAuth = await readAuthFile(authPath);

		if (JSON.stringify(targetAuth) === JSON.stringify(currentAuth)) {
			await vscode.window.showInformationMessage('This backup is already the current auth.');
			return;
		}

		const existingBackupPath = await findMatchingBackup(backupDir, currentAuth);
		if (!existingBackupPath) {
			const safetyBackupPath = path.join(
				backupDir,
				`${buildTimestamp()}-auto-before-switch-${safeSegment(currentSummary.email ?? 'unknown')}.json`
			);
			await fs.copyFile(CODEX_AUTH_PATH, safetyBackupPath);
		}

		await fs.copyFile(authPath, CODEX_AUTH_PATH);
		aiAuthSwitcherViewProvider?.refresh();

		const restoredSummary = summarizeAuth(targetAuth);
		const message = `Switched auth to ${restoredSummary.email ?? path.basename(authPath)}. Reload Window so Codex picks up the new auth.`;
		const reload = 'Reload Window';
		const choice = await vscode.window.showInformationMessage(message, reload);

		if (choice === reload) {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		await showError('Failed to restore auth backup.', error);
	}
}

async function reloadTargetExtension(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		'Codex auth changes apply after reloading the VS Code window.',
		'Reload Window'
	);

	if (choice === 'Reload Window') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

async function deleteBackupPath(authPath: string | null): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('No backup path was provided for delete.');
			return;
		}

		const auth = await readAuthFile(authPath);
		const summary = summarizeAuth(auth);
		const currentAuth = await readAuthFile(CODEX_AUTH_PATH);
		const isCurrent = JSON.stringify(auth) === JSON.stringify(currentAuth);
		const targetName = summary.email ?? path.basename(authPath);
		const message = isCurrent
			? `Delete backup ${targetName}? This only removes the saved backup file. It will not log out the currently loaded account until you switch auth again.`
			: `Delete backup ${targetName}?`;

		const choice = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			'Delete'
		);

		if (choice !== 'Delete') {
			return;
		}

		await fs.unlink(authPath);
		aiAuthSwitcherViewProvider?.refresh();
		await vscode.window.showInformationMessage(`Deleted ${path.basename(authPath)}.`);
	} catch (error) {
		await showError('Failed to delete auth backup.', error);
	}
}

async function readCurrentAccountSummary(): Promise<AccountSummary> {
	const auth = await readAuthFile(CODEX_AUTH_PATH);
	return summarizeAuth(auth);
}

async function readAuthFile(filePath: string): Promise<AuthFile> {
	const raw = await fs.readFile(filePath, 'utf8');
	return JSON.parse(raw) as AuthFile;
}

function summarizeAuth(auth: AuthFile): AccountSummary {
	const idTokenPayload = decodeJwt(auth.tokens?.id_token);
	const accessTokenPayload = decodeJwt(auth.tokens?.access_token);
	const authClaims = getAuthClaims(idTokenPayload) ?? getAuthClaims(accessTokenPayload) ?? {};
	const profileClaims = getProfileClaims(accessTokenPayload) ?? {};

	return {
		email: stringOrNull(idTokenPayload?.email) ?? stringOrNull(profileClaims.email),
		name: stringOrNull(idTokenPayload?.name),
		plan: stringOrNull(authClaims.chatgpt_plan_type),
		accountId: stringOrNull(authClaims.chatgpt_account_id) ?? stringOrNull(auth.tokens?.account_id),
		userId: stringOrNull(authClaims.chatgpt_user_id) ?? stringOrNull(authClaims.user_id),
		idTokenExpiresAt: formatJwtExpiry(idTokenPayload?.exp),
		accessTokenExpiresAt: formatJwtExpiry(accessTokenPayload?.exp),
		lastRefresh: formatLastRefresh(auth.last_refresh),
	};
}

function decodeJwt(token: string | undefined): JwtPayload | null {
	if (!token) {
		return null;
	}

	const parts = token.split('.');
	if (parts.length < 2) {
		return null;
	}

	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtPayload;
	} catch {
		return null;
	}
}

function getAuthClaims(payload: JwtPayload | null): JwtPayload | null {
	const value = payload?.['https://api.openai.com/auth'];
	return isRecord(value) ? value : null;
}

function getProfileClaims(payload: JwtPayload | null): JwtPayload | null {
	const value = payload?.['https://api.openai.com/profile'];
	return isRecord(value) ? value : null;
}

function formatJwtExpiry(value: unknown): string | null {
	if (typeof value !== 'number') {
		return null;
	}

	return formatLocalDateTime(new Date(value * 1000));
}

function formatLastRefresh(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return formatLocalDateTime(date);
}

function formatLocalDateTime(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	const hour = `${date.getHours()}`.padStart(2, '0');
	const minute = `${date.getMinutes()}`.padStart(2, '0');
	const second = `${date.getSeconds()}`.padStart(2, '0');
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function ensureBackupDirectory(context: vscode.ExtensionContext): Promise<string> {
	const backupDir = path.join(context.globalStorageUri.fsPath, 'auth-backups');
	await fs.mkdir(backupDir, { recursive: true });
	return backupDir;
}

function buildBackupFileName(summary: AccountSummary): string {
	const email = safeSegment(summary.email ?? 'unknown');
	const accountId = safeSegment(summary.accountId ?? 'no-account-id');
	return `${buildTimestamp()}-${email}-${accountId}.json`;
}

function buildTimestamp(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');
	const hour = `${now.getHours()}`.padStart(2, '0');
	const minute = `${now.getMinutes()}`.padStart(2, '0');
	const second = `${now.getSeconds()}`.padStart(2, '0');
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function listBackupFiles(backupDir: string): Promise<AuthBackupQuickPickItem[]> {
	const currentAuth = await readAuthFile(CODEX_AUTH_PATH);
	const currentRaw = JSON.stringify(currentAuth);
	const entries = await fs.readdir(backupDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.sort((a, b) => b.name.localeCompare(a.name));

	return Promise.all(
		files.map(async (entry) => {
			const authPath = path.join(backupDir, entry.name);
			const auth = await readAuthFile(authPath);
			const summary = summarizeAuth(auth);
			const isCurrent = JSON.stringify(auth) === currentRaw;
			return {
				label: summary.email ?? entry.name,
				description: isCurrent ? 'Current' : undefined,
				detail: entry.name,
				authPath,
				isCurrent,
				summary,
			};
		})
	);
}

async function findMatchingBackup(backupDir: string, auth: AuthFile): Promise<string | null> {
	const currentRaw = JSON.stringify(auth);
	const entries = await fs.readdir(backupDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}

		const authPath = path.join(backupDir, entry.name);
		const existing = await readAuthFile(authPath);
		if (JSON.stringify(existing) === currentRaw) {
			return authPath;
		}
	}

	return null;
}

function createInfoItem(label: string, value: string): AIAuthSwitcherItem {
	const item = new AIAuthSwitcherItem('info', label, vscode.TreeItemCollapsibleState.None);
	item.description = value;
	item.tooltip = `${label}: ${value}`;
	item.iconPath = new vscode.ThemeIcon('circle-small-filled');
	return item;
}

function createActionItem(label: string, command: string, iconId: string): AIAuthSwitcherItem {
	const item = new AIAuthSwitcherItem('action', label, vscode.TreeItemCollapsibleState.None);
	item.command = { command, title: label };
	item.iconPath = new vscode.ThemeIcon(iconId);
	return item;
}

function createBackupItem(entry: AuthBackupQuickPickItem): AIAuthSwitcherItem {
	const item = new AIAuthSwitcherItem(
		'backup',
		entry.label,
		vscode.TreeItemCollapsibleState.Collapsed,
		buildBackupDetailItems(entry),
		entry.authPath
	);
	item.description = entry.isCurrent ? 'Current' : undefined;
	item.tooltip = entry.detail;
	item.iconPath = new vscode.ThemeIcon('file');
	item.contextValue = 'authBackup';
	return item;
}

function buildBackupDetailItems(entry: AuthBackupQuickPickItem): AIAuthSwitcherItem[] {
	const summary = entry.summary;
	if (!summary) {
		return [createInfoItem('File', entry.detail ?? 'unknown')];
	}

	return [
		createInfoItem('Email', summary.email ?? 'unknown'),
		createInfoItem('Name', summary.name ?? 'unknown'),
		createInfoItem('Plan', summary.plan ?? 'unknown'),
		createInfoItem('Account ID', summary.accountId ?? 'unknown'),
		createInfoItem('User ID', summary.userId ?? 'unknown'),
		createInfoItem('ID Token Expires', summary.idTokenExpiresAt ?? 'unknown'),
		createInfoItem('Access Token Expires', summary.accessTokenExpiresAt ?? 'unknown'),
		createInfoItem('Last Refresh', summary.lastRefresh ?? 'unknown'),
		createInfoItem('File', entry.detail ?? 'unknown'),
	];
}

function resolveAuthPath(target?: string | AIAuthSwitcherItem): string | null {
	if (typeof target === 'string') {
		return target;
	}

	if (target instanceof AIAuthSwitcherItem && typeof target.authPath === 'string') {
		return target.authPath;
	}

	return null;
}

async function showError(prefix: string, error: unknown): Promise<void> {
	const detail = error instanceof Error ? error.message : String(error);
	await vscode.window.showErrorMessage(`${prefix} ${detail}`);
}
