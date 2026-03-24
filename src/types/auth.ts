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

export type AccountSummary = {
	email: string | null;
	name: string | null;
	plan: string | null;
	accountId: string | null;
	userId: string | null;
	idTokenExpiresAt: string | null;
	accessTokenExpiresAt: string | null;
	lastRefresh: string | null;
};

export type AuthBackupQuickPickItem = vscode.QuickPickItem & {
	authPath: string;
	isCurrent?: boolean;
	summary?: AccountSummary;
};
