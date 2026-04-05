import * as vscode from 'vscode';
import {
	ensureBackupDirectory,
	isBackupSelected,
	listBackupFiles,
	readCurrentAccountSummary,
} from '../services/authStorage';
import { fetchCodexUsageSummary, fetchCodexUsageSummaryForAuth } from '../services/codexUsage';
import { AccountSummary, CodexUsageSummary } from '../types/auth';

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
	private backupCountdownRefreshTimer: NodeJS.Timeout | null = null;

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
		this.scheduleBackupCountdownRefresh();
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
				await this.syncCurrentBackupUsageFromCurrentAccount();
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
					createInfoItem('授权健康度', getTokenHealthStatus(summary).label),
					createInfoItem('自动续期', summary.hasRefreshToken ? '支持' : '不支持'),
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

	private async syncCurrentBackupUsageFromCurrentAccount(): Promise<void> {
		if (!this.codexUsage) {
			return;
		}

		const backupDir = await ensureBackupDirectory(this.context);
		const entries = await listBackupFiles(backupDir);
		const currentEntry = entries.find((entry) => entry.isCurrent);
		if (!currentEntry) {
			return;
		}

		this.backupUsageByPath.set(currentEntry.authPath, this.codexUsage);
		this.backupUsageErrorByPath.delete(currentEntry.authPath);
		await this.saveBackupUsageCache();
	}

	private scheduleBackupCountdownRefresh(): void {
		if (this.backupCountdownRefreshTimer) {
			clearTimeout(this.backupCountdownRefreshTimer);
			this.backupCountdownRefreshTimer = null;
		}

		const nextRefreshMs = getNextBackupCountdownRefreshMs(
			this.backupUsageByPath,
			this.backupUsageErrorByPath,
			this.backupUsageLoadingPaths
		);
		if (nextRefreshMs === null) {
			return;
		}

		this.backupCountdownRefreshTimer = setTimeout(() => {
			this.backupCountdownRefreshTimer = null;
			this.refresh();
		}, nextRefreshMs);
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
		hasAccessToken: boolean;
		hasRefreshToken: boolean;
		hasAccountId: boolean;
	};
}, usage: CodexUsageSummary | null, usageError: string | null, usageLoading: boolean): AIAuthSwitcherItem {
	const item = new AIAuthSwitcherItem(
		'backup',
		formatBackupItemLabel(entry.label, entry.summary ?? null, usage, usageError, usageLoading),
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
		hasAccessToken: boolean;
		hasRefreshToken: boolean;
		hasAccountId: boolean;
	};
}, usage: CodexUsageSummary | null, usageError: string | null, usageLoading: boolean): AIAuthSwitcherItem[] {
	const summary = entry.summary;
	const items: AIAuthSwitcherItem[] = [];

	if (!summary) {
		items.push(createInfoItem('文件', entry.detail ?? '未知'));
		return appendBackupUsageItems(items, usage, usageError, usageLoading);
	}

	const tokenHealth = getTokenHealthStatus(summary);
	items.push(
		createInfoItem('邮箱', summary.email ?? '未知'),
		createInfoItem('名称', summary.name ?? '未知'),
		createInfoItem('套餐', summary.plan ?? '未知'),
		createInfoItem('账号 ID', summary.accountId ?? '未知'),
		createInfoItem('用户 ID', summary.userId ?? '未知'),
		createInfoItem('授权健康度', tokenHealth.label),
		createInfoItem('健康说明', tokenHealth.reason),
		createInfoItem('Access Token 到期时间', summary.accessTokenExpiresAt ?? '未知'),
		createInfoItem('距 Access Token 到期', formatAccessTokenCountdown(summary)),
		createInfoItem('Refresh Token', summary.hasRefreshToken ? '已提供' : '缺失'),
		createInfoItem('自动续期', summary.hasRefreshToken ? '支持' : '不支持')
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
	summary: AccountSummary | null,
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

	const healthText = getTokenHealthStatus(summary).label;
	return `${formatPercent(usage?.weeklyWindow?.usedPercent)} | ${formatWeeklyResetCountdown(usage)} | ${healthText} | ${label}`;
}

function getTokenHealthStatus(summary: AccountSummary | null): { label: string; reason: string } {
	if (!summary) {
		return { label: '未知', reason: '缺少账号摘要信息。' };
	}

	if (!summary.hasAccessToken || !summary.hasAccountId) {
		return {
			label: '异常',
			reason: `缺少${[
				!summary.hasAccessToken ? 'access_token' : null,
				!summary.hasAccountId ? 'account_id' : null,
			]
				.filter((value): value is string => value !== null)
				.join('、')}。`,
		};
	}

	const accessTokenExpiry = parseLocalDateTime(summary.accessTokenExpiresAt);
	if (!summary.hasRefreshToken) {
		if (accessTokenExpiry && accessTokenExpiry.getTime() <= Date.now()) {
			return { label: '已过期', reason: '缺少 refresh_token，且 access_token 已过期。' };
		}
		return { label: '不可续期', reason: '缺少 refresh_token，access_token 过期后无法自动续期。' };
	}

	if (!accessTokenExpiry) {
		return { label: '健康', reason: '包含 refresh_token，可自动续期。' };
	}

	const diffMs = accessTokenExpiry.getTime() - Date.now();
	if (diffMs <= 0) {
		return { label: '已过期', reason: 'access_token 已过期，但存在 refresh_token，可尝试自动续期。' };
	}
	if (diffMs <= 24 * 60 * 60 * 1000) {
		return { label: '临期', reason: 'access_token 将在 24 小时内过期，但存在 refresh_token。' };
	}
	return { label: '健康', reason: 'access_token 状态正常，且存在 refresh_token。' };
}

function formatAccessTokenCountdown(summary: AccountSummary): string {
	const accessTokenExpiry = parseLocalDateTime(summary.accessTokenExpiresAt);
	if (!accessTokenExpiry) {
		return '未知';
	}

	const diffMs = accessTokenExpiry.getTime() - Date.now();
	if (diffMs <= 0) {
		return '已过期';
	}

	return formatDuration(diffMs);
}

function formatWeeklyResetCountdown(usage: CodexUsageSummary | null): string {
	const resetAt = parseLocalDateTime(usage?.weeklyWindow?.resetAt ?? null);
	if (!resetAt) {
		return '未知';
	}

	const diffMs = resetAt.getTime() - Date.now();
	if (diffMs <= 0) {
		return '已至';
	}

	return formatDuration(diffMs);
}

function getNextBackupCountdownRefreshMs(
	usageByPath: ReadonlyMap<string, CodexUsageSummary>,
	errorByPath: ReadonlyMap<string, string>,
	loadingPaths: ReadonlySet<string>
): number | null {
	let nextRefreshMs: number | null = null;

	for (const [authPath, usage] of usageByPath.entries()) {
		if (errorByPath.has(authPath) || loadingPaths.has(authPath)) {
			continue;
		}

		const resetAt = parseLocalDateTime(usage.weeklyWindow?.resetAt ?? null);
		if (!resetAt) {
			continue;
		}

		const diffMs = resetAt.getTime() - Date.now();
		if (diffMs <= 0) {
			continue;
		}

		const candidateMs = getCountdownRefreshIntervalMs(diffMs);
		if (nextRefreshMs === null || candidateMs < nextRefreshMs) {
			nextRefreshMs = candidateMs;
		}
	}

	return nextRefreshMs;
}

function getCountdownRefreshIntervalMs(diffMs: number): number {
	if (diffMs > 60 * 60 * 1000) {
		return 10 * 60 * 1000;
	}
	if (diffMs > 5 * 60 * 1000) {
		return 3 * 60 * 1000;
	}
	if (diffMs > 60 * 1000) {
		return 60 * 1000;
	}
	return 10 * 1000;
}

function parseLocalDateTime(value: string | null): Date | null {
	if (!value) {
		return null;
	}

	const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) {
		return null;
	}

	const [, year, month, day, hour, minute, second] = match;
	const date = new Date(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second)
	);
	return Number.isNaN(date.getTime()) ? null : date;
}

function formatDuration(diffMs: number): string {
	const totalSeconds = Math.floor(diffMs / 1000);
	const days = Math.floor(totalSeconds / (24 * 60 * 60));
	const hours = Math.floor((totalSeconds % (24 * 60 * 60)) / (60 * 60));
	const minutes = Math.floor((totalSeconds % (60 * 60)) / 60);
	const seconds = totalSeconds % 60;
	const hhmmss = [hours, minutes, seconds].map((value) => `${value}`.padStart(2, '0')).join(':');

	return days > 0 ? `${days}d ${hhmmss}` : hhmmss;
}
