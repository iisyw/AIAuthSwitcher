import { AccountSummary, AuthFile, JwtPayload } from '../types/auth';

export function summarizeAuth(auth: AuthFile): AccountSummary {
	const idTokenPayload = decodeJwt(auth.tokens?.id_token);
	const accessTokenPayload = decodeJwt(auth.tokens?.access_token);
	const authClaims = getAuthClaims(idTokenPayload) ?? getAuthClaims(accessTokenPayload) ?? {};
	const profileClaims = getProfileClaims(accessTokenPayload) ?? {};

	return {
		email: stringOrNull(idTokenPayload?.email) ?? stringOrNull(profileClaims.email),
		name: stringOrNull(idTokenPayload?.name),
		plan: stringOrNull(authClaims.chatgpt_plan_type),
		accountId: stringOrNull(authClaims.chatgpt_account_id) ?? stringOrNull(auth.tokens?.account_id),
		userId: stringOrNull(authClaims.chatgpt_user_id) ?? stringOrNull(authClaims.user_id),
		idTokenExpiresAt: formatJwtExpiry(idTokenPayload?.exp),
		accessTokenExpiresAt: formatJwtExpiry(accessTokenPayload?.exp),
		lastRefresh: formatLastRefresh(auth.last_refresh),
		hasAccessToken: Boolean(auth.tokens?.access_token?.trim()),
		hasRefreshToken: Boolean(auth.tokens?.refresh_token?.trim()),
		hasAccountId: Boolean(auth.tokens?.account_id?.trim()),
	};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatLocalDateTime(date: Date): string {
	const year = date.getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	const hour = `${date.getHours()}`.padStart(2, '0');
	const minute = `${date.getMinutes()}`.padStart(2, '0');
	const second = `${date.getSeconds()}`.padStart(2, '0');
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

export function buildTimestamp(): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = `${now.getMonth() + 1}`.padStart(2, '0');
	const day = `${now.getDate()}`.padStart(2, '0');
	const hour = `${now.getHours()}`.padStart(2, '0');
	const minute = `${now.getMinutes()}`.padStart(2, '0');
	const second = `${now.getSeconds()}`.padStart(2, '0');
	return `${year}${month}${day}-${hour}${minute}${second}`;
}

export function safeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function decodeJwt(token: string | undefined): JwtPayload | null {
	if (!token) {
		return null;
	}

	const parts = token.split('.');
	if (parts.length < 2) {
		return null;
	}

	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtPayload;
	} catch {
		return null;
	}
}

function getAuthClaims(payload: JwtPayload | null): JwtPayload | null {
	const value = payload?.['https://api.openai.com/auth'];
	return isRecord(value) ? value : null;
}

function getProfileClaims(payload: JwtPayload | null): JwtPayload | null {
	const value = payload?.['https://api.openai.com/profile'];
	return isRecord(value) ? value : null;
}

function formatJwtExpiry(value: unknown): string | null {
	if (typeof value !== 'number') {
		return null;
	}

	return formatLocalDateTime(new Date(value * 1000));
}

function formatLastRefresh(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return formatLocalDateTime(date);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}
