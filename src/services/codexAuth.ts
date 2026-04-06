import * as vscode from 'vscode';
import { saveAddedAuth } from './authStorage';
import {
	completeCodexOAuthBrowserFlow,
	createCodexOAuthBrowserFlow,
} from './codexOAuthClient';
import { summarizeAuth } from '../utils/authSummary';

export async function addAccount(
	context: vscode.ExtensionContext,
	refresh: () => void,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	const picked = await vscode.window.showQuickPick(
		[
			{
				label: 'Codex',
				description: 'OpenAI OAuth 登录',
			},
		],
		{
			placeHolder: '选择要添加的账号类型',
			ignoreFocusOut: true,
		}
	);

	if (!picked) {
		return;
	}

	if (picked.label === 'Codex') {
		await addCodexAccount(context, refresh, outputChannel);
	}
}

async function addCodexAccount(
	context: vscode.ExtensionContext,
	refresh: () => void,
	outputChannel: vscode.OutputChannel
): Promise<void> {
	outputChannel.clear();
	const flow = createCodexOAuthBrowserFlow();
	outputChannel.appendLine('开始执行 Codex 网页 OAuth 登录');
	outputChannel.appendLine(`授权链接: ${flow.authorizeUrl}`);
	outputChannel.appendLine(`回调地址: ${flow.redirectUri}`);

	try {
		await vscode.env.openExternal(vscode.Uri.parse(flow.authorizeUrl));
		await vscode.window.showInformationMessage(
			'已打开 Codex 授权页面，登录完成后，把地址栏完整回调 URL 粘贴回来即可。',
			'确定'
		);

		const callbackInput = await promptForAuthorizationCallback(flow);
		if (!callbackInput) {
			return;
		}

		const auth = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: '正在完成 Codex 网页授权登录',
				cancellable: false,
			},
			async () => await completeCodexOAuthBrowserFlow(callbackInput, flow)
		);
		await saveAddedAuth(context, auth, refresh);
		const summary = summarizeAuth(auth);
		const reload = '重载窗口';
		const choice = await vscode.window.showInformationMessage(
			`已添加并切换到 ${summary.email ?? summary.accountId ?? '该账号'}。请重载窗口，让 Codex 读取新的授权。`,
			reload
		);
		if (choice === reload) {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		await showError('添加 Codex 账号失败。', error);
	}
}

async function promptForAuthorizationCallback(flow: { redirectUri: string; authorizeUrl: string }): Promise<string | undefined> {
	const pasteFromClipboard = '从剪贴板粘贴';
	const reopen = '重新打开授权页';
	const copyRedirect = '复制回调地址';

	while (true) {
		const callbackInput = await vscode.window.showInputBox({
			prompt: `完成网页登录后，粘贴跳转到 ${flow.redirectUri} 的完整回调 URL。`,
			placeHolder: 'http://localhost:1455/auth/callback?code=...&state=...',
			ignoreFocusOut: true,
			validateInput: (value) => {
				if (!value.trim()) {
					return '回调 URL 不能为空。';
				}
				return value.includes('code=') && value.includes('state=')
					? undefined
					: '请输入包含 code 和 state 的完整回调 URL。';
			},
		});

		if (callbackInput) {
			return callbackInput;
		}

		const choice = await vscode.window.showInformationMessage(
			'还没有粘贴回调 URL。你可以重新打开授权页面，或从剪贴板自动读取。',
			pasteFromClipboard,
			reopen,
			copyRedirect
		);
		if (choice === pasteFromClipboard) {
			const clipboardText = await vscode.env.clipboard.readText();
			if (clipboardText.trim()) {
				return clipboardText;
			}
			await vscode.window.showWarningMessage('剪贴板里没有可用的回调 URL。');
			continue;
		}
		if (choice === reopen) {
			await vscode.env.openExternal(vscode.Uri.parse(flow.authorizeUrl));
			continue;
		}
		if (choice === copyRedirect) {
			await vscode.env.clipboard.writeText(flow.redirectUri);
			continue;
		}
		return undefined;
	}
}

async function showError(prefix: string, error: unknown): Promise<void> {
	const detail = error instanceof Error ? error.message : String(error);
	await vscode.window.showErrorMessage(`${prefix} ${detail}`);
}
