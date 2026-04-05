import * as vscode from 'vscode';

export type JwtPayload = Record<string, unknown>;

export type AuthFile = {
	auth_mode?: string;
	OPENAI_API_KEY?: string;
	last_refresh?: string | null;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
};

export type AuthBundle = Record<string, AuthFile>;

export type CodexRateLimitWindow = {
	usedPercent: number | null;
	resetAt: string | null;
	resetAfterSeconds: number | null;
	limitWindowSeconds: number | null;
};

export type CodexUsageSummary = {
	planType: string | null;
	isAvailable: boolean | null;
	upstreamStatus: number | null;
	email: string | null;
	accountId: string | null;
	userId: string | null;
	lastFetchedAt: string | null;
	fiveHourWindow: CodexRateLimitWindow | null;
	weeklyWindow: CodexRateLimitWindow | null;
	message: string | null;
	raw: unknown;
};

export type AccountSummary = {
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

export type AuthBackupQuickPickItem = vscode.QuickPickItem & {
	authPath: string;
	isCurrent?: boolean;
	summary?: AccountSummary;
};
