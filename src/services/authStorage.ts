import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AccountSummary, AuthBackupQuickPickItem, AuthBundle, AuthFile } from '../types/auth';
import { buildTimestamp, isRecord, safeSegment, summarizeAuth } from '../utils/authSummary';

export const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');

const selectedBackupPaths = new Set<string>();

export async function showCurrentAccount(): Promise<void> {
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

export async function backupCurrentAuth(
	context: vscode.ExtensionContext,
	refresh: () => void
): Promise<void> {
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
		refresh();

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

export async function importAuthFiles(
	context: vscode.ExtensionContext,
	refresh: () => void
): Promise<string[]> {
	return await importAuthFilesFromFile(context, refresh);
}

async function importAuthFilesFromFile(
	context: vscode.ExtensionContext,
	refresh: () => void
): Promise<string[]> {
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
			return [];
		}

		const backupDir = await ensureBackupDirectory(context);
		let importedCount = 0;
		let updatedCount = 0;
		let invalidCount = 0;
		let parsedAccountCount = 0;
		const importedPaths = new Set<string>();
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
			importedPaths.add(targetPath);

			if (existingBackupPath) {
				updatedCount += 1;
			} else {
				importedCount += 1;
			}
		}

		refresh();
		await vscode.window.showInformationMessage(
			`导入完成。文件 ${selectedFiles.length} 个，解析账号 ${parsedAccountCount} 个，新增 ${importedCount} 个，更新 ${updatedCount} 个，无效文件 ${invalidCount} 个。`
		);
		return [...importedPaths];
	} catch (error) {
		await showError('导入授权文件失败。', error);
		return [];
	}
}

export async function restoreBackupPath(
	context: vscode.ExtensionContext,
	authPath: string | null,
	refresh: () => void
): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('未提供要恢复的备份路径。');
			return;
		}

		const backupDir = await ensureBackupDirectory(context);
		const currentAuth = await tryReadAuthFile(CODEX_AUTH_PATH);
		const currentSummary = currentAuth ? summarizeAuth(currentAuth) : null;
		const targetAuth = await readAuthFile(authPath);

		if (currentAuth && JSON.stringify(targetAuth) === JSON.stringify(currentAuth)) {
			await vscode.window.showInformationMessage('这份备份已经是当前授权。');
			return;
		}

		const existingBackupPath = currentAuth ? await findMatchingBackup(backupDir, currentAuth) : null;
		if (currentAuth && !existingBackupPath) {
			const safetyBackupPath = path.join(
				backupDir,
				`${buildTimestamp()}-auto-before-switch-${safeSegment(currentSummary?.email ?? 'unknown')}.json`
			);
			await fs.copyFile(CODEX_AUTH_PATH, safetyBackupPath);
		}

		await fs.mkdir(path.dirname(CODEX_AUTH_PATH), { recursive: true });
		await fs.copyFile(authPath, CODEX_AUTH_PATH);
		refresh();

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

export async function exportSelectedBackups(): Promise<void> {
	if (selectedBackupPaths.size === 0) {
		await vscode.window.showInformationMessage('尚未勾选要导出的备份。');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		[
			{
				label: '导出到文件',
				description: '按 JSON 文件保存到本地',
			},
			{
				label: '打开到窗口直接复制',
				description: '在编辑器里打开导出内容，手动复制',
			},
		],
		{
			placeHolder: '选择导出方式',
			ignoreFocusOut: true,
		}
	);

	if (!picked) {
		return;
	}

	if (picked.label === '打开到窗口直接复制') {
		await exportSelectedBackupsToEditor();
		return;
	}

	await exportSelectedBackupsToFile();
}

async function exportSelectedBackupsToFile(): Promise<void> {
	try {
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

async function exportSelectedBackupsToEditor(): Promise<void> {
	try {
		const exportPayload = await buildExportPayload();
		const content = `${JSON.stringify(exportPayload, null, 2)}\n`;
		const doc = await vscode.workspace.openTextDocument({
			content,
			language: 'json',
		});
		await vscode.window.showTextDocument(doc, { preview: false });
		await vscode.window.showInformationMessage('已在编辑器中打开导出内容，可以直接复制。');
	} catch (error) {
		await showError('打开导出内容失败。', error);
	}
}

async function buildExportPayload(): Promise<AuthBundle> {
	const exportPayload: AuthBundle = {};

	for (const authPath of selectedBackupPaths) {
		const auth = await readAuthFile(authPath);
		const summary = summarizeAuth(auth);
		const exportKey = buildExportKey(summary, exportPayload);
		exportPayload[exportKey] = auth;
	}

	return exportPayload;
}

export async function reloadTargetExtension(): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		'Codex 授权变更需要重载 VS Code 窗口后才会生效。',
		'重载窗口'
	);

	if (choice === '重载窗口') {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	}
}

export async function deleteBackupPath(authPath: string | null, refresh: () => void): Promise<void> {
	try {
		if (!authPath) {
			await vscode.window.showWarningMessage('未提供要删除的备份路径。');
			return;
		}

		const auth = await readAuthFile(authPath);
		const summary = summarizeAuth(auth);
		const currentAuth = await tryReadAuthFile(CODEX_AUTH_PATH);
		const isCurrent = currentAuth ? JSON.stringify(auth) === JSON.stringify(currentAuth) : false;
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
		refresh();
		await vscode.window.showInformationMessage(`已删除 ${path.basename(authPath)}。`);
	} catch (error) {
		await showError('删除授权备份失败。', error);
	}
}

export async function readCurrentAccountSummary(): Promise<AccountSummary> {
	const auth = await readAuthFile(CODEX_AUTH_PATH);
	return summarizeAuth(auth);
}

export async function readAuthFile(filePath: string): Promise<AuthFile> {
	return (await readJsonFile(filePath)) as AuthFile;
}

async function tryReadAuthFile(filePath: string): Promise<AuthFile | null> {
	try {
		return await readAuthFile(filePath);
	} catch (error) {
		if (isMissingFileError(error)) {
			return null;
		}
		throw error;
	}
}

export async function ensureBackupDirectory(context: vscode.ExtensionContext): Promise<string> {
	const backupDir = path.join(context.globalStorageUri.fsPath, 'auth-backups');
	await fs.mkdir(backupDir, { recursive: true });
	return backupDir;
}

export async function listBackupFiles(backupDir: string): Promise<AuthBackupQuickPickItem[]> {
	const currentAuth = await tryReadAuthFile(CODEX_AUTH_PATH);
	const currentRaw = currentAuth ? JSON.stringify(currentAuth) : null;
	const entries = await fs.readdir(backupDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.sort((a, b) => b.name.localeCompare(a.name));

	return Promise.all(
		files.map(async (entry) => {
			const authPath = path.join(backupDir, entry.name);
			const auth = await readAuthFile(authPath);
			const summary = summarizeAuth(auth);
			const isCurrent = currentRaw ? JSON.stringify(auth) === currentRaw : false;
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

export function syncSelectedBackup(authPath: string, checked: boolean): void {
	if (checked) {
		selectedBackupPaths.add(authPath);
		return;
	}

	selectedBackupPaths.delete(authPath);
}

export function isBackupSelected(authPath: string): boolean {
	return selectedBackupPaths.has(authPath);
}

export async function saveAddedAuth(
	context: vscode.ExtensionContext,
	auth: AuthFile,
	refresh: () => void
): Promise<void> {
	await persistAuthFile(context, auth, refresh);
}

export async function persistCurrentAuth(
	context: vscode.ExtensionContext,
	auth: AuthFile,
	refresh: () => void
): Promise<void> {
	await persistAuthFile(context, auth, refresh);
}

export async function writeAuthFile(filePath: string, auth: AuthFile): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
}

async function persistAuthFile(
	context: vscode.ExtensionContext,
	auth: AuthFile,
	refresh: () => void
): Promise<void> {
	await fs.mkdir(path.dirname(CODEX_AUTH_PATH), { recursive: true });
	const backupDir = await ensureBackupDirectory(context);
	const summary = summarizeAuth(auth);
	const existingBackupPath =
		(await findMatchingBackup(backupDir, auth)) ??
		(await findBackupByIdentity(backupDir, summary));
	const backupPath = existingBackupPath ?? path.join(backupDir, buildBackupFileName(summary));

	await fs.writeFile(backupPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
	await fs.writeFile(CODEX_AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`, 'utf8');
	refresh();
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

function buildIdentityKey(summary: AccountSummary): string | null {
	const email = summary.email?.trim().toLowerCase() ?? '';
	const accountId = summary.accountId?.trim().toLowerCase() ?? '';

	if (!email && !accountId) {
		return null;
	}

	return `${email}::${accountId}`;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readJsonFile(filePath: string): Promise<unknown> {
	const raw = await fs.readFile(filePath, 'utf8');
	return JSON.parse(raw) as unknown;
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

async function showError(prefix: string, error: unknown): Promise<void> {
	const detail = error instanceof Error ? error.message : String(error);
	await vscode.window.showErrorMessage(`${prefix} ${detail}`);
}
