import * as vscode from 'vscode';
import { saveAddedAuth } from './authStorage';
import { performCodexOAuthLogin } from './codexOAuthClient';
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
	const email = await vscode.window.showInputBox({
		prompt: '输入 Codex 账号邮箱',
		placeHolder: 'name@example.com',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : '邮箱不能为空。'),
	});

	if (!email) {
		return;
	}

	const password = await vscode.window.showInputBox({
		prompt: '输入 Codex 账号密码',
		ignoreFocusOut: true,
		password: true,
		validateInput: (value) => (value ? undefined : '密码不能为空。'),
	});

	if (!password) {
		return;
	}

	outputChannel.clear();
	outputChannel.appendLine(`开始执行 Codex OAuth 登录: ${email}`);

	try {
		const auth = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `正在登录 Codex 账号 ${email}`,
				cancellable: false,
			},
			async () =>
				await performCodexOAuthLogin(email, password, {
					log: (message) => {
						outputChannel.appendLine(message);
					},
					promptPassword: async (prompt) =>
						await vscode.window.showInputBox({
							prompt,
							ignoreFocusOut: true,
							password: true,
							validateInput: (value) => (value ? undefined : '密码不能为空。'),
						}),
					promptOtp: async (prompt) =>
						await vscode.window.showInputBox({
							prompt,
							placeHolder: '6 位验证码',
							ignoreFocusOut: true,
							validateInput: (value) =>
								/^\d{6}$/.test(value.trim()) ? undefined : '请输入 6 位数字验证码。',
						}),
				})
		);
		await saveAddedAuth(context, auth, refresh);
		const summary = summarizeAuth(auth);
		const reload = '重载窗口';
		const choice = await vscode.window.showInformationMessage(
			`已添加并切换到 ${summary.email ?? email}。请重载窗口，让 Codex 读取新的授权。`,
			reload
		);
		if (choice === reload) {
			await vscode.commands.executeCommand('workbench.action.reloadWindow');
		}
	} catch (error) {
		await showError('添加 Codex 账号失败。', error);
	}
}

async function showError(prefix: string, error: unknown): Promise<void> {
	const detail = error instanceof Error ? error.message : String(error);
	await vscode.window.showErrorMessage(`${prefix} ${detail}`);
}
