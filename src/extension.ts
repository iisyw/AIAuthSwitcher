import * as vscode from 'vscode';
import { addAccount } from './services/codexAuth';
import {
	backupCurrentAuth,
	deleteBackupPath,
	exportSelectedBackups,
	importAuthFiles,
	reloadTargetExtension,
	restoreBackupPath,
	showCurrentAccount,
	syncSelectedBackup,
} from './services/authStorage';
import { AIAuthSwitcherItem, AIAuthSwitcherViewProvider } from './views/accountsViewProvider';

let aiAuthSwitcherViewProvider: AIAuthSwitcherViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	aiAuthSwitcherViewProvider = new AIAuthSwitcherViewProvider(context);
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
