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

type AuthBundle = Record<string, AuthFile>;

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
				'当前账号',
				vscode.TreeItemCollapsibleState.Expanded,
				[
					createInfoItem('邮箱', summary.email ?? '未知'),
					createInfoItem('名称', summary.name ?? '未知'),
					createInfoItem('套餐', summary.plan ?? '未知'),
					createInfoItem('账号 ID', summary.accountId ?? '未知'),
					createInfoItem('用户 ID', summary.userId ?? '未知'),
					createInfoItem('ID 令牌过期时间', summary.idTokenExpiresAt ?? '未知'),
					createInfoItem('访问令牌过期时间', summary.accessTokenExpiresAt ?? '未知'),
					createInfoItem('最后刷新时间', summary.lastRefresh ?? '未知'),
				]
			);
			section.description = summary.email ?? '未知';
			section.iconPath = new vscode.ThemeIcon('account');
			return section;
		} catch (error) {
			const section = new AIAuthSwitcherItem(
				'section',
				'当前账号',
				vscode.TreeItemCollapsibleState.Expanded,
				[createInfoItem('错误', error instanceof Error ? error.message : String(error))]
			);
			section.iconPath = new vscode.ThemeIcon('warning');
			return section;
		}
	}

	private buildActionsSection(): AIAuthSwitcherItem {
		const actions = [
			createActionItem('备份当前授权', 'ai-auth-switcher.backupCurrentAuth', 'archive'),
			createActionItem('重载窗口', 'ai-auth-switcher.reloadTargetExtension', 'sync'),
		];

		const section = new AIAuthSwitcherItem(
			'section',
			'操作',
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
				: [createInfoItem('状态', '暂无备份')];
		const section = new AIAuthSwitcherItem(
			'section',
			'备份',
			vscode.TreeItemCollapsibleState.Expanded,
			children
		);
		section.contextValue = 'authBackupsSection';
		section.description = `${entries.length}`;
		section.iconPath = new vscode.ThemeIcon('files');
		return section;
	}
}

const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
let aiAuthSwitcherViewProvider: AIAuthSwitcherViewProvider | undefined;
const selectedBackupPaths = new Set<string>();

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
		vscode.commands.registerCommand('ai-auth-switcher.importAuthFiles', async () => {
			await importAuthFiles(context);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.exportAllBackups', async () => {
			await exportSelectedBackups();
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

	treeView.onDidChangeCheckboxState((event) => {
		for (const [item, state] of event.items) {
			if (item.kind !== 'backup' || !item.authPath) {
				continue;
			}

			if (state === vscode.TreeItemCheckboxState.Checked) {
				selectedBackupPaths.add(item.authPath);
			} else {
				selectedBackupPaths.delete(item.authPath);
			}
		}
	});

	context.subscriptions.push(...commands);
}

export function deactivate() {}

async function showCurrentAccount(): Promise<void> {
	try {
		const summary = await readCurrentAccountSummary();
		const lines = [
			`邮箱: ${summary.email ?? '未知'}`,
			`名称: ${summary.name ?? '未知'}`,
			`套餐: ${summary.plan ?? '未知'}`,
			`账号 ID: ${summary.accountId ?? '未知'}`,
			`用户 ID: ${summary.userId ?? '未知'}`,
			`ID 令牌过期时间: ${summary.idTokenExpiresAt ?? '未知'}`,
			`访问令牌过期时间: ${summary.accessTokenExpiresAt ?? '未知'}`,
			`最后刷新时间: ${summary.lastRefresh ?? '未知'}`,
			`授权文件: ${CODEX_AUTH_PATH}`,
		];

		const doc = await vscode.workspace.openTextDocument({
			content: lines.join('\n'),
			language: 'text',
		});
		await vscode.window.showTextDocument(doc, { preview: true });
	} catch (error) {
		await showError('读取当前账号失败。', error);
	}
}

async function backupCurrentAuth(context: vscode.ExtensionContext): Promise<void> {
	try {
		const auth = await readAuthFile(CODEX_AUTH_PATH);
		const summary = summarizeAuth(auth);
		const backupDir = await ensureBackupDirectory(context);
		const existingBackupPath =
			(await findMatchingBackup(backupDir, auth)) ??
			(await findBackupByIdentity(backupDir, summary));
		const backupPath = existingBackupPath ?? path.join(backupDir, buildBackupFileName(summary));
		const wasOverwrite = Boolean(existingBackupPath);

		await fs.copyFile(CODEX_AUTH_PATH, backupPath);
		aiAuthSwitcherViewProvider?.refresh();

		const action = '查看当前账号';
		const picked = await vscode.window.showInformationMessage(
			wasOverwrite
				? `已更新现有备份 ${path.basename(backupPath)}。`
				: `已备份到 ${path.basename(backupPath)}。`,
			action
		);

		if (picked === action) {
			await showCurrentAccount();
		}
	} catch (error) {
		await showError('备份当前授权失败。', error);
	}
}

async function importAuthFiles(context: vscode.ExtensionContext): Promise<void> {
	try {
		const selectedFiles = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: '导入授权文件',
			filters: {
				JSON: ['json'],
			},
		});

		if (!selectedFiles || selectedFiles.length === 0) {
			return;
		}

		const backupDir = await ensureBackupDirectory(context);
		let importedCount = 0;
		let updatedCount = 0;
		let invalidCount = 0;
		let parsedAccountCount = 0;
		const pendingImports = new Map<string, AuthFile>();
		const pendingFallbackImports: AuthFile[] = [];

		for (const selectedFile of selectedFiles) {
			try {
				const payload = await readJsonFile(selectedFile.fsPath);
				const authEntries = extractImportableAuthEntries(payload);

				if (authEntries.length === 0) {
					invalidCount += 1;
					continue;
				}

				parsedAccountCount += authEntries.length;

				for (const auth of authEntries) {
					const summary = summarizeAuth(auth);
					const identityKey = buildIdentityKey(summary);

					if (identityKey) {
						pendingImports.set(identityKey, auth);
					} else {
						pendingFallbackImports.push(auth);
					}
				}
			} catch {
				invalidCount += 1;
			}
		}

		for (const auth of [...pendingImports.values(), ...pendingFallbackImports]) {
			const summary = summarizeAuth(auth);
			const existingBackupPath =
				(await findMatchingBackup(backupDir, auth)) ??
				(await findBackupByIdentity(backupDir, summary));
			const targetPath = existingBackupPath ?? path.join(backupDir, buildBackupFileName(summary));

			await fs.writeFile(targetPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');

			if (existingBackupPath) {
				updatedCount += 1;
			} else {
				importedCount += 1;
			}
		}

		aiAuthSwitcherViewProvider?.refresh();
		await vscode.window.showInformationMessage(
			`导入完成。文件 ${selectedFiles.length} 个，解析账号 ${parsedAccountCount} 个，新增 ${importedCount} 个，更新 ${updatedCount} 个，无效文件 ${invalidCount} 个。`
		);
	} catch (error) {
		await showError('导入授权文件失败。', error);
	}
}

async function restoreBackupPath(context: vscode.ExtensionContext, authPath: string | null): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('未提供要恢复的备份路径。');
			return;
		}

		const backupDir = await ensureBackupDirectory(context);
		const currentAuth = await readAuthFile(CODEX_AUTH_PATH);
		const currentSummary = summarizeAuth(currentAuth);
		const targetAuth = await readAuthFile(authPath);

		if (JSON.stringify(targetAuth) === JSON.stringify(currentAuth)) {
			await vscode.window.showInformationMessage('这份备份已经是当前授权。');
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
		const message = `已切换到 ${restoredSummary.email ?? path.basename(authPath)}。请重载窗口，让 Codex 读取新的授权。`;
		const reload = '重载窗口';
		const choice = await vscode.window.showInformationMessage(message, reload);

		if (choice === reload) {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		await showError('恢复授权备份失败。', error);
	}
}

async function exportSelectedBackups(): Promise<void> {
	try {
		if (selectedBackupPaths.size === 0) {
			await vscode.window.showInformationMessage('尚未勾选要导出的备份。');
			return;
		}

		const exportPayload: AuthBundle = {};

		for (const authPath of selectedBackupPaths) {
			const auth = await readAuthFile(authPath);
			const summary = summarizeAuth(auth);
			const exportKey = buildExportKey(summary, exportPayload);
			exportPayload[exportKey] = auth;
		}

		const targetUri = await vscode.window.showSaveDialog({
			saveLabel: '导出已选备份',
			defaultUri: vscode.Uri.file(path.join(os.homedir(), `ai-auth-switcher-export-${buildTimestamp()}.json`)),
			filters: {
				JSON: ['json'],
			},
		});

		if (!targetUri) {
			return;
		}

		await fs.writeFile(targetUri.fsPath, `${JSON.stringify(exportPayload, null, 2)}\n`, 'utf8');

		await vscode.window.showInformationMessage(
			`已导出 ${selectedBackupPaths.size} 个备份到 ${path.basename(targetUri.fsPath)}。`
		);
	} catch (error) {
		await showError('导出已选备份失败。', error);
	}
}

async function reloadTargetExtension(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		'Codex 授权变更需要重载 VS Code 窗口后才会生效。',
		'重载窗口'
	);

	if (choice === '重载窗口') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

async function deleteBackupPath(authPath: string | null): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('未提供要删除的备份路径。');
			return;
		}

		const auth = await readAuthFile(authPath);
		const summary = summarizeAuth(auth);
		const currentAuth = await readAuthFile(CODEX_AUTH_PATH);
		const isCurrent = JSON.stringify(auth) === JSON.stringify(currentAuth);
		const targetName = summary.email ?? path.basename(authPath);
		const message = isCurrent
			? `确定删除备份 ${targetName} 吗？这只会删除保存的备份文件，不会立刻让当前已加载账号退出，除非你之后再次切换授权。`
			: `确定删除备份 ${targetName} 吗？`;

		const choice = await vscode.window.showWarningMessage(
			message,
			{ modal: true },
			'删除'
		);

		if (choice !== '删除') {
			return;
		}

		selectedBackupPaths.delete(authPath);
		await fs.unlink(authPath);
		aiAuthSwitcherViewProvider?.refresh();
		await vscode.window.showInformationMessage(`已删除 ${path.basename(authPath)}。`);
	} catch (error) {
		await showError('删除授权备份失败。', error);
	}
}

async function readCurrentAccountSummary(): Promise<AccountSummary> {
	const auth = await readAuthFile(CODEX_AUTH_PATH);
	return summarizeAuth(auth);
}

async function readAuthFile(filePath: string): Promise<AuthFile> {
	return (await readJsonFile(filePath)) as AuthFile;
}

async function readJsonFile(filePath: string): Promise<unknown> {
	const raw = await fs.readFile(filePath, 'utf8');
	return JSON.parse(raw) as unknown;
}

function isSupportedAuthFile(auth: AuthFile): boolean {
	return Boolean(
		auth.tokens?.id_token ||
			auth.tokens?.access_token ||
			auth.tokens?.refresh_token ||
			auth.tokens?.account_id
	);
}

function extractImportableAuthEntries(payload: unknown): AuthFile[] {
	if (isRecord(payload) && isSupportedAuthFile(payload as AuthFile)) {
		return [payload as AuthFile];
	}

	if (!isRecord(payload)) {
		return [];
	}

	const entries: AuthFile[] = [];
	for (const value of Object.values(payload)) {
		if (isRecord(value) && isSupportedAuthFile(value as AuthFile)) {
			entries.push(value as AuthFile);
		}
	}

	return entries;
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

function buildExportKey(summary: AccountSummary, payload: AuthBundle): string {
	const baseKey = (summary.email ?? summary.accountId ?? 'unknown').trim() || 'unknown';
	if (!payload[baseKey]) {
		return baseKey;
	}

	const suffix = safeSegment(summary.accountId ?? buildTimestamp());
	const candidate = `${baseKey}-${suffix}`;
	if (!payload[candidate]) {
		return candidate;
	}

	let index = 2;
	while (payload[`${candidate}-${index}`]) {
		index += 1;
	}

	return `${candidate}-${index}`;
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
				description: isCurrent ? '当前' : undefined,
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

async function findBackupByIdentity(backupDir: string, summary: AccountSummary): Promise<string | null> {
	const targetKey = buildIdentityKey(summary);
	if (!targetKey) {
		return null;
	}

	const entries = await fs.readdir(backupDir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) {
			continue;
		}

		const authPath = path.join(backupDir, entry.name);
		const existing = await readAuthFile(authPath);
		const existingKey = buildIdentityKey(summarizeAuth(existing));
		if (existingKey === targetKey) {
			return authPath;
		}
	}

	return null;
}

function buildIdentityKey(summary: AccountSummary): string | null {
	const email = summary.email?.trim().toLowerCase() ?? '';
	const accountId = summary.accountId?.trim().toLowerCase() ?? '';

	if (!email && !accountId) {
		return null;
	}

	return `${email}::${accountId}`;
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
	item.description = entry.isCurrent ? '当前' : undefined;
	item.tooltip = entry.detail;
	item.iconPath = new vscode.ThemeIcon('file');
	item.contextValue = 'authBackup';
	item.id = entry.authPath;
	item.checkboxState = selectedBackupPaths.has(entry.authPath)
		? vscode.TreeItemCheckboxState.Checked
		: vscode.TreeItemCheckboxState.Unchecked;
	return item;
}

function buildBackupDetailItems(entry: AuthBackupQuickPickItem): AIAuthSwitcherItem[] {
	const summary = entry.summary;
	if (!summary) {
		return [createInfoItem('文件', entry.detail ?? '未知')];
	}

	return [
		createInfoItem('邮箱', summary.email ?? '未知'),
		createInfoItem('名称', summary.name ?? '未知'),
		createInfoItem('套餐', summary.plan ?? '未知'),
		createInfoItem('账号 ID', summary.accountId ?? '未知'),
		createInfoItem('用户 ID', summary.userId ?? '未知'),
		createInfoItem('ID 令牌过期时间', summary.idTokenExpiresAt ?? '未知'),
		createInfoItem('访问令牌过期时间', summary.accessTokenExpiresAt ?? '未知'),
		createInfoItem('最后刷新时间', summary.lastRefresh ?? '未知'),
		createInfoItem('文件', entry.detail ?? '未知'),
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
