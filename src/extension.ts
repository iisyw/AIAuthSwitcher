import * as vscode from 'vscode';
import { addAccount } from './services/codexAuth';
import {
	backupCurrentAuth,
	deleteBackupPath,
	exportSelectedBackups,
	importAuthFiles,
	persistCurrentAuth,
	readAuthFile,
	reloadTargetExtension,
	restoreBackupPath,
	showCurrentAccount,
	syncSelectedBackup,
	CODEX_AUTH_PATH,
	writeAuthFile,
} from './services/authStorage';
import { refreshCodexAuthTokens } from './services/codexOAuthClient';
import { fetchCodexUsageSummaryForAuth } from './services/codexUsage';
import { AIAuthSwitcherItem, AIAuthSwitcherViewProvider } from './views/accountsViewProvider';

let aiAuthSwitcherViewProvider: AIAuthSwitcherViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	aiAuthSwitcherViewProvider = new AIAuthSwitcherViewProvider(context);
	void aiAuthSwitcherViewProvider.initialize();
	const outputChannel = vscode.window.createOutputChannel('AIAuthSwitcher');

	const treeView = vscode.window.createTreeView('ai-auth-switcher.accountsView', {
		treeDataProvider: aiAuthSwitcherViewProvider,
		showCollapseAll: false,
	});

	const refreshView = () => {
		aiAuthSwitcherViewProvider?.refresh();
	};

	const commands = [
		treeView,
		outputChannel,
		vscode.commands.registerCommand('ai-auth-switcher.showCurrentAccount', async () => {
			await showCurrentAccount();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.backupCurrentAuth', async () => {
			await backupCurrentAuth(context, refreshView);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.importAuthFiles', async () => {
			await importAuthFiles(context, refreshView);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.exportAllBackups', async () => {
			await exportSelectedBackups();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.reloadTargetExtension', async () => {
			await reloadTargetExtension();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.refreshView', async () => {
			refreshView();
		}),
		vscode.commands.registerCommand('ai-auth-switcher.addAccount', async () => {
			await addAccount(context, refreshView, outputChannel);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.refreshCodexAuth', async () => {
			try {
				const auth = await readAuthFile(CODEX_AUTH_PATH);
				const refreshedAuth = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在刷新 Codex 授权',
						cancellable: false,
					},
					async () => await refreshCodexAuthTokens(auth)
				);
				await persistCurrentAuth(context, refreshedAuth, refreshView);
				await aiAuthSwitcherViewProvider?.refreshCodexUsage(true);
				aiAuthSwitcherViewProvider?.refresh();
				const reload = '重载窗口';
				const choice = await vscode.window.showInformationMessage(
					'Codex 授权已刷新并写回本地文件。',
					reload
				);
				if (choice === reload) {
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`刷新 Codex 授权失败。${detail}`);
			}
		}),
		vscode.commands.registerCommand('ai-auth-switcher.fetchCodexUsage', async () => {
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在查询 Codex 用量',
						cancellable: false,
					},
					async () => await aiAuthSwitcherViewProvider?.refreshCodexUsage(true)
				);
				refreshView();
				const usageError = aiAuthSwitcherViewProvider?.getCodexUsageError();
				if (usageError) {
					await vscode.window.showErrorMessage(`查询 Codex 用量失败。${usageError}`);
					return;
				}
				await vscode.window.showInformationMessage('Codex 用量已更新。');
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`查询 Codex 用量失败。${detail}`);
			}
		}),
		vscode.commands.registerCommand('ai-auth-switcher.fetchBackupCodexUsage', async (target?: string | AIAuthSwitcherItem) => {
			const authPath = resolveAuthPath(target);
			if (!authPath) {
				await vscode.window.showWarningMessage('未提供要查询的备份路径。');
				return;
			}

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在查询备份账号的 Codex 用量',
						cancellable: false,
					},
					async () =>
						await aiAuthSwitcherViewProvider?.refreshBackupCodexUsage(authPath, async (path) => {
							const auth = await readAuthFile(path);
							const result = await fetchCodexUsageSummaryForAuth(auth);
							if (result.authChanged) {
								await writeAuthFile(path, result.auth);
							}
							return {
								summary: result.summary,
								authChanged: result.authChanged,
							};
						})
				);
				refreshView();
				const usageError = aiAuthSwitcherViewProvider?.getBackupCodexUsageError(authPath);
				if (usageError) {
					await vscode.window.showErrorMessage(`查询备份账号 Codex 用量失败。${usageError}`);
					return;
				}
				await vscode.window.showInformationMessage('备份账号 Codex 用量已更新。');
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`查询备份账号 Codex 用量失败。${detail}`);
			}
		}),
		vscode.commands.registerCommand('ai-auth-switcher.restoreBackupItem', async (target?: string | AIAuthSwitcherItem) => {
			await restoreBackupPath(context, resolveAuthPath(target), refreshView);
		}),
		vscode.commands.registerCommand('ai-auth-switcher.deleteBackupItem', async (target?: string | AIAuthSwitcherItem) => {
			await deleteBackupPath(resolveAuthPath(target), refreshView);
		}),
	];

	treeView.onDidChangeCheckboxState((event) => {
		for (const [item, state] of event.items) {
			if (item.kind !== 'backup' || !item.authPath) {
				continue;
			}

			syncSelectedBackup(item.authPath, state === vscode.TreeItemCheckboxState.Checked);
		}
	});

	context.subscriptions.push(...commands);
}

export function deactivate() {}

function resolveAuthPath(target?: string | AIAuthSwitcherItem): string | null {
	if (typeof target === 'string') {
		return target;
	}

	if (target instanceof AIAuthSwitcherItem && typeof target.authPath === 'string') {
		return target.authPath;
	}

	return null;
}
