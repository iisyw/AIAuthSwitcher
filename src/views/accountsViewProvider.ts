import * as vscode from 'vscode';
import {
	ensureBackupDirectory,
	isBackupSelected,
	listBackupFiles,
	readCurrentAccountSummary,
} from '../services/authStorage';

type ItemKind = 'section' | 'info' | 'action' | 'backup';

export class AIAuthSwitcherItem extends vscode.TreeItem {
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

export class AIAuthSwitcherViewProvider implements vscode.TreeDataProvider<AIAuthSwitcherItem> {
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

function createBackupItem(entry: {
	label: string;
	detail?: string;
	authPath: string;
	isCurrent?: boolean;
	summary?: {
		email: string | null;
		name: string | null;
		plan: string | null;
		accountId: string | null;
		userId: string | null;
		idTokenExpiresAt: string | null;
		accessTokenExpiresAt: string | null;
		lastRefresh: string | null;
	};
}): AIAuthSwitcherItem {
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
	item.checkboxState = isBackupSelected(entry.authPath)
		? vscode.TreeItemCheckboxState.Checked
		: vscode.TreeItemCheckboxState.Unchecked;
	return item;
}

function buildBackupDetailItems(entry: {
	detail?: string;
	summary?: {
		email: string | null;
		name: string | null;
		plan: string | null;
		accountId: string | null;
		userId: string | null;
		idTokenExpiresAt: string | null;
		accessTokenExpiresAt: string | null;
		lastRefresh: string | null;
	};
}): AIAuthSwitcherItem[] {
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
