import * as vscode from 'vscode';
import {
	ensureBackupDirectory,
	isBackupSelected,
	listBackupFiles,
	readCurrentAccountSummary,
} from '../services/authStorage';
import { fetchCodexUsageSummary, fetchCodexUsageSummaryForAuth } from '../services/codexUsage';
import { CodexUsageSummary } from '../types/auth';

type ItemKind = 'section' | 'info' | 'action' | 'backup';
const BACKUP_USAGE_CACHE_KEY = 'backupCodexUsageCache';

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
	private codexUsage: CodexUsageSummary | null = null;
	private codexUsageError: string | null = null;
	private codexUsageLoading = false;
	private codexUsageTask: Promise<void> | null = null;
	private readonly backupUsageByPath = new Map<string, CodexUsageSummary>();
	private readonly backupUsageErrorByPath = new Map<string, string>();
	private readonly backupUsageLoadingPaths = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	async initialize(): Promise<void> {
		const cached = this.context.globalState.get<Record<string, CodexUsageSummary>>(BACKUP_USAGE_CACHE_KEY);
		if (!cached || typeof cached !== 'object') {
			return;
		}

		for (const [authPath, summary] of Object.entries(cached)) {
			if (summary && typeof summary === 'object') {
				this.backupUsageByPath.set(authPath, summary);
			}
		}
		this.refresh();
	}

	refresh(): void {
		this.changeEmitter.fire();
	}

	getCodexUsageError(): string | null {
		return this.codexUsageError;
	}

	getBackupCodexUsageError(authPath: string): string | null {
		return this.backupUsageErrorByPath.get(authPath) ?? null;
	}

	async refreshCodexUsage(force = false): Promise<void> {
		if (force) {
			this.codexUsage = null;
			this.codexUsageError = null;
		}
		if (!force && (this.codexUsage || this.codexUsageError)) {
			return;
		}
		if (this.codexUsageTask) {
			await this.codexUsageTask;
			return;
		}

		this.codexUsageLoading = true;
		this.codexUsageError = null;
		this.codexUsageTask = (async () => {
			try {
				this.codexUsage = await fetchCodexUsageSummary();
			} catch (error) {
				this.codexUsage = null;
				this.codexUsageError = error instanceof Error ? error.message : String(error);
			} finally {
				this.codexUsageLoading = false;
				this.codexUsageTask = null;
			}
		})();

		await this.codexUsageTask;
	}

	async refreshBackupCodexUsage(
		authPath: string,
		runFetch: (authPath: string) => Promise<{ summary: CodexUsageSummary; authChanged: boolean }>
	): Promise<void> {
		if (!authPath) {
			return;
		}
		this.backupUsageLoadingPaths.add(authPath);
		this.backupUsageErrorByPath.delete(authPath);
		this.refresh();

		try {
			const result = await runFetch(authPath);
			this.backupUsageByPath.set(authPath, result.summary);
			this.backupUsageErrorByPath.delete(authPath);
			await this.saveBackupUsageCache();
		} catch (error) {
			this.backupUsageByPath.delete(authPath);
			this.backupUsageErrorByPath.set(
				authPath,
				error instanceof Error ? error.message : String(error)
			);
			await this.saveBackupUsageCache();
		} finally {
			this.backupUsageLoadingPaths.delete(authPath);
			this.refresh();
		}
	}

	async getChildren(element?: AIAuthSwitcherItem): Promise<AIAuthSwitcherItem[]> {
		if (element) {
			return element.children;
		}

		const currentAccountSection = await this.buildCurrentAccountSection();
		const codexUsageSection = await this.buildCodexUsageSection();
		const actionsSection = this.buildActionsSection();
		const backupsSection = await this.buildBackupsSection();
		const codexRoot = new AIAuthSwitcherItem(
			'section',
			'CODEX',
			vscode.TreeItemCollapsibleState.Expanded,
			[currentAccountSection, codexUsageSection, actionsSection, backupsSection]
		);
		codexRoot.iconPath = new vscode.ThemeIcon('server');
		codexRoot.id = 'codex-root';
		return [codexRoot];
	}

	getTreeItem(element: AIAuthSwitcherItem): vscode.TreeItem {
		return element;
	}

	private async buildCurrentAccountSection(): Promise<AIAuthSwitcherItem> {
		try {
			const summary = await readCurrentAccountSummary();
			const section = new AIAuthSwitcherItem(
				'section',
				'当前账号信息',
				vscode.TreeItemCollapsibleState.Expanded,
				[
					createInfoItem('邮箱', summary.email ?? '未知'),
					createInfoItem('名称', summary.name ?? '未知'),
					createInfoItem('套餐', summary.plan ?? '未知'),
					createInfoItem('账号 ID', summary.accountId ?? '未知'),
					createInfoItem('用户 ID', summary.userId ?? '未知'),
				]
			);
			section.description = summary.email ?? '未知';
			section.iconPath = new vscode.ThemeIcon('account');
			return section;
		} catch (error) {
			const section = new AIAuthSwitcherItem(
				'section',
				'当前账号信息',
				vscode.TreeItemCollapsibleState.Expanded,
				[createInfoItem('错误', error instanceof Error ? error.message : String(error))]
			);
			section.iconPath = new vscode.ThemeIcon('warning');
			return section;
		}
	}

	private buildActionsSection(): AIAuthSwitcherItem {
		const actions = [
			createActionItem('刷新 Codex 授权', 'ai-auth-switcher.refreshCodexAuth', 'key'),
			createActionItem('查询 Codex 用量', 'ai-auth-switcher.fetchCodexUsage', 'pulse'),
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

	private async buildCodexUsageSection(): Promise<AIAuthSwitcherItem> {
		await this.refreshCodexUsage();

		if (this.codexUsageLoading && !this.codexUsage && !this.codexUsageError) {
			return createSection('Codex 用量', [createInfoItem('状态', '加载中...')], 'pulse');
		}

		if (this.codexUsageError) {
			return createSection('当前账号Codex用量', [createInfoItem('错误', this.codexUsageError)], 'warning');
		}

		if (!this.codexUsage) {
			return createSection('当前账号Codex用量', [createInfoItem('状态', '暂无数据')], 'pulse');
		}

		const usage = this.codexUsage;
		const usageItems = [
			createInfoItem('状态', formatAvailability(usage.isAvailable)),
			createInfoItem('上游状态码', usage.upstreamStatus?.toString() ?? '未知'),
		];
		if (usage.planType !== 'free') {
			usageItems.push(
				createInfoItem('5小时窗口已用', formatPercent(usage.fiveHourWindow?.usedPercent)),
				createInfoItem('5小时窗口重置时间', usage.fiveHourWindow?.resetAt ?? '未知')
			);
		}
		usageItems.push(
			createInfoItem('每周窗口已用', formatPercent(usage.weeklyWindow?.usedPercent)),
			createInfoItem('每周窗口重置时间', usage.weeklyWindow?.resetAt ?? '未知'),
			createInfoItem('上次查询时间', usage.lastFetchedAt ?? '未知'),
			createInfoItem('查询结果', usage.message ?? '正常')
		);
		const section = createSection(
			'当前账号Codex用量',
			usageItems,
			'pulse'
		);
		section.description = formatAvailability(usage.isAvailable);
		return section;
	}

	private async buildBackupsSection(): Promise<AIAuthSwitcherItem> {
		const backupDir = await ensureBackupDirectory(this.context);
		const entries = await listBackupFiles(backupDir);
		const sortedEntries = sortBackupEntriesByUsage(
			entries,
			this.backupUsageByPath,
			this.backupUsageErrorByPath
		);
		const children =
			sortedEntries.length > 0
				? sortedEntries.map((entry) =>
						createBackupItem(
							entry,
							this.backupUsageByPath.get(entry.authPath) ?? null,
							this.backupUsageErrorByPath.get(entry.authPath) ?? null,
							this.backupUsageLoadingPaths.has(entry.authPath)
						)
				  )
				: [createInfoItem('状态', '暂无备份')];
		const section = new AIAuthSwitcherItem(
			'section',
			'账号备份列表',
			vscode.TreeItemCollapsibleState.Expanded,
			children
		);
		section.contextValue = 'authBackupsSection';
		section.description = `${sortedEntries.length}`;
		section.iconPath = new vscode.ThemeIcon('files');
		return section;
	}

	private async saveBackupUsageCache(): Promise<void> {
		const payload = Object.fromEntries(this.backupUsageByPath.entries());
		await this.context.globalState.update(BACKUP_USAGE_CACHE_KEY, payload);
	}
}

function createSection(label: string, children: AIAuthSwitcherItem[], iconId: string): AIAuthSwitcherItem {
	const section = new AIAuthSwitcherItem('section', label, vscode.TreeItemCollapsibleState.Expanded, children);
	section.iconPath = new vscode.ThemeIcon(iconId);
	return section;
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

function sortBackupEntriesByUsage<T extends { authPath: string; label: string }>(
	entries: T[],
	usageByPath: ReadonlyMap<string, CodexUsageSummary>,
	errorByPath: ReadonlyMap<string, string>
): T[] {
	return entries
		.map((entry, index) => ({
			entry,
			index,
			sortKey: getBackupUsageSortKey(
				usageByPath.get(entry.authPath) ?? null,
				errorByPath.get(entry.authPath) ?? null
			),
		}))
		.sort((left, right) => {
			if (left.sortKey.category !== right.sortKey.category) {
				return left.sortKey.category - right.sortKey.category;
			}
			if (left.sortKey.weeklyUsedPercent !== right.sortKey.weeklyUsedPercent) {
				return left.sortKey.weeklyUsedPercent - right.sortKey.weeklyUsedPercent;
			}
			const labelCompare = left.entry.label.localeCompare(right.entry.label, 'zh-CN');
			if (labelCompare !== 0) {
				return labelCompare;
			}
			return left.index - right.index;
		})
		.map((item) => item.entry);
}

function getBackupUsageSortKey(
	usage: CodexUsageSummary | null,
	error: string | null
): { category: number; weeklyUsedPercent: number } {
	if (error) {
		return { category: 2, weeklyUsedPercent: Number.POSITIVE_INFINITY };
	}

	const weeklyUsedPercent = usage?.weeklyWindow?.usedPercent;
	if (typeof weeklyUsedPercent === 'number' && Number.isFinite(weeklyUsedPercent)) {
		return { category: 0, weeklyUsedPercent };
	}

	return { category: 1, weeklyUsedPercent: Number.POSITIVE_INFINITY };
}

function formatAvailability(value: boolean | null): string {
	if (value === true) {
		return '可用';
	}
	if (value === false) {
		return '受限';
	}
	return '待确认';
}

function formatPercent(value: number | null | undefined): string {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return '未知';
	}
	return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}

function formatPlanType(value: string | null): string {
	switch (value) {
		case 'free':
			return 'Free';
		case 'plus':
			return 'Plus';
		case 'pro':
			return 'Pro';
		case 'team':
			return 'Team';
		case 'enterprise':
			return 'Enterprise';
		default:
			return value ?? '未知';
	}
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
}, usage: CodexUsageSummary | null, usageError: string | null, usageLoading: boolean): AIAuthSwitcherItem {
	const item = new AIAuthSwitcherItem(
		'backup',
		formatBackupItemLabel(entry.label, usage, usageError, usageLoading),
		vscode.TreeItemCollapsibleState.Collapsed,
		buildBackupDetailItems(entry, usage, usageError, usageLoading),
		entry.authPath
	);
	item.description = entry.isCurrent ? '当前' : undefined;
	item.tooltip = entry.detail;
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
}, usage: CodexUsageSummary | null, usageError: string | null, usageLoading: boolean): AIAuthSwitcherItem[] {
	const summary = entry.summary;
	const items: AIAuthSwitcherItem[] = [];

	if (!summary) {
		items.push(createInfoItem('文件', entry.detail ?? '未知'));
		return appendBackupUsageItems(items, usage, usageError, usageLoading);
	}

	items.push(
		createInfoItem('邮箱', summary.email ?? '未知'),
		createInfoItem('名称', summary.name ?? '未知'),
		createInfoItem('套餐', summary.plan ?? '未知'),
		createInfoItem('账号 ID', summary.accountId ?? '未知'),
		createInfoItem('用户 ID', summary.userId ?? '未知')
	);
	return appendBackupUsageItems(items, usage, usageError, usageLoading);
}

function appendBackupUsageItems(
	items: AIAuthSwitcherItem[],
	usage: CodexUsageSummary | null,
	usageError: string | null,
	usageLoading: boolean
): AIAuthSwitcherItem[] {
	if (usageLoading) {
		items.push(createInfoItem('Codex用量', '查询中...'));
		return items;
	}

	if (usageError) {
		items.push(createInfoItem('Codex用量错误', usageError));
		return items;
	}

	if (!usage) {
		return items;
	}

	items.push(createInfoItem('Codex状态', formatAvailability(usage.isAvailable)));
	if (usage.planType !== 'free') {
		items.push(createInfoItem('5小时窗口已用', formatPercent(usage.fiveHourWindow?.usedPercent)));
		items.push(createInfoItem('5小时窗口重置时间', usage.fiveHourWindow?.resetAt ?? '未知'));
	}
	items.push(createInfoItem('每周窗口已用', formatPercent(usage.weeklyWindow?.usedPercent)));
	items.push(createInfoItem('每周窗口重置时间', usage.weeklyWindow?.resetAt ?? '未知'));
	items.push(createInfoItem('Codex查询结果', usage.message ?? '正常'));
	items.push(createInfoItem('上次查询时间', usage.lastFetchedAt ?? '未知'));
	return items;
}

function formatBackupItemLabel(
	label: string,
	usage: CodexUsageSummary | null,
	usageError: string | null,
	usageLoading: boolean
): string {
	if (usageLoading) {
		return `查询中 | ${label}`;
	}

	if (usageError) {
		return `失败 | ${label}`;
	}

	const weeklyUsedPercent = usage?.weeklyWindow?.usedPercent;
	if (typeof weeklyUsedPercent === 'number' && Number.isFinite(weeklyUsedPercent)) {
		return `${formatPercent(weeklyUsedPercent)} | ${label}`;
	}

	return `未知 | ${label}`;
}
