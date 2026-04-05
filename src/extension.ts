import * as vscode from 'vscode';
import { addAccount } from './services/codexAuth';
import {
	backupCurrentAuth,
	deleteBackupPath,
	ensureBackupDirectory,
	exportSelectedBackups,
	importAuthFiles,
	listBackupFiles,
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
import { summarizeAuth } from './utils/authSummary';
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
			const importedAuthPaths = await importAuthFiles(context, refreshView);
			if (!aiAuthSwitcherViewProvider || importedAuthPaths.length === 0) {
				return;
			}

			const viewProvider = aiAuthSwitcherViewProvider;
			const failedAccounts = await fetchBackupUsageForPaths(
				importedAuthPaths,
				viewProvider,
				'正在查询导入账号的 Codex 用量'
			);
			refreshView();
			if (failedAccounts.length > 0) {
				await vscode.window.showWarningMessage(
					`导入后的用量查询完成，${failedAccounts.length} 个账号失败：${failedAccounts.join('；')}`
				);
				return;
			}
			await vscode.window.showInformationMessage('导入账号的 Codex 用量已更新。');
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
					async () => await fetchAndPersistBackupUsage(aiAuthSwitcherViewProvider, authPath)
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
		vscode.commands.registerCommand('ai-auth-switcher.fetchAllBackupCodexUsage', async () => {
			if (!aiAuthSwitcherViewProvider) {
				return;
			}
			const viewProvider = aiAuthSwitcherViewProvider;

			try {
				const backupDir = await ensureBackupDirectory(context);
				const entries = await listBackupFiles(backupDir);
				if (entries.length === 0) {
					await vscode.window.showInformationMessage('暂无备份账号可查询。');
					return;
				}

				const failedAccounts: string[] = [];
				let cancelled = false;
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在顺序查询备份账号的 Codex 用量',
						cancellable: true,
					},
					async (progress, token) => {
						for (let index = 0; index < entries.length; index += 1) {
							if (token.isCancellationRequested) {
								cancelled = true;
								break;
							}

							const entry = entries[index];
							const current = index + 1;
							progress.report({
								message: `正在查询 ${current}/${entries.length}: ${entry.label}`,
								increment: index === 0 ? 0 : 100 / entries.length,
							});

							await fetchAndPersistBackupUsage(viewProvider, entry.authPath);

							const usageError = viewProvider.getBackupCodexUsageError(entry.authPath);
							if (usageError) {
								failedAccounts.push(`${entry.label}: ${usageError}`);
							}

							if (index === entries.length - 1 || token.isCancellationRequested) {
								if (token.isCancellationRequested) {
									cancelled = true;
								}
								continue;
							}

							const delayMs = randomDelayMs(3_000, 10_000);
							progress.report({
								message: `等待 ${Math.round(delayMs / 1000)} 秒后继续下一个账号`,
								increment: 0,
							});
							await delay(delayMs, token);
						}
					}
				);

				refreshView();
				if (cancelled) {
					await vscode.window.showWarningMessage('批量查询已取消，已保留已完成账号的用量结果。');
					return;
				}
				if (failedAccounts.length > 0) {
					await vscode.window.showWarningMessage(
						`批量查询完成，${failedAccounts.length} 个账号失败：${failedAccounts.join('；')}`
					);
					return;
				}
				await vscode.window.showInformationMessage('备份账号 Codex 用量已全部更新。');
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(`批量查询备份账号 Codex 用量失败。${detail}`);
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

function randomDelayMs(minMs: number, maxMs: number): number {
	return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
	if (ms <= 0) {
		return;
	}

	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			disposable.dispose();
			resolve();
		}, ms);
		const disposable = token.onCancellationRequested(() => {
			clearTimeout(timer);
			disposable.dispose();
			resolve();
		});
	});
}

async function fetchBackupUsageForPaths(
	authPaths: string[],
	viewProvider: AIAuthSwitcherViewProvider,
	title: string
): Promise<string[]> {
	const failedAccounts: string[] = [];
	const uniqueAuthPaths = [...new Set(authPaths)];

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title,
			cancellable: false,
		},
		async (progress) => {
			for (let index = 0; index < uniqueAuthPaths.length; index += 1) {
				const authPath = uniqueAuthPaths[index];
				const current = index + 1;
				const auth = await readAuthFile(authPath);
				const summary = summarizeAuth(auth);
				const label = summary.email?.trim() || summary.accountId?.trim() || authPath;
				progress.report({
					message: `正在查询 ${current}/${uniqueAuthPaths.length}: ${label}`,
					increment: index === 0 ? 0 : 100 / uniqueAuthPaths.length,
				});

				await fetchAndPersistBackupUsage(viewProvider, authPath);
				const usageError = viewProvider.getBackupCodexUsageError(authPath);
				if (usageError) {
					failedAccounts.push(`${label}: ${usageError}`);
				}
			}
		}
	);

	return failedAccounts;
}

async function fetchAndPersistBackupUsage(
	viewProvider: AIAuthSwitcherViewProvider | undefined,
	authPath: string
): Promise<void> {
	await viewProvider?.refreshBackupCodexUsage(authPath, async (path) => {
		const auth = await readAuthFile(path);
		const result = await fetchCodexUsageSummaryForAuth(auth);
		if (result.authChanged) {
			await writeAuthFile(path, result.auth);
		}
		return {
			summary: result.summary,
			authChanged: result.authChanged,
		};
	});
}
