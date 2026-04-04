import { AuthFile, CodexRateLimitWindow, CodexUsageSummary } from '../types/auth';
import { readAuthFile, CODEX_AUTH_PATH } from './authStorage';
import { refreshCodexAuthTokens } from './codexOAuthClient';
import { formatLocalDateTime } from '../utils/authSummary';

const CHATGPT_BASE = 'https://chatgpt.com';

type UsageResponsePayload = {
	plan_type?: unknown;
	email?: unknown;
	account_id?: unknown;
	user_id?: unknown;
	rate_limit?: {
		allowed?: unknown;
		limit_reached?: unknown;
		plan_type?: unknown;
		primary_window?: RateLimitWindowPayload | null;
		secondary_window?: RateLimitWindowPayload | null;
	};
};

type RateLimitWindowPayload = {
	used_percent?: unknown;
	reset_at?: unknown;
	reset_after_seconds?: unknown;
	limit_window_seconds?: unknown;
};

type UsageFetchResult = {
	statusCode: number;
	body: unknown;
	auth: AuthFile;
};

export async function fetchCodexUsageSummary(): Promise<CodexUsageSummary> {
	const auth = await readAuthFile(CODEX_AUTH_PATH);
	const result = await fetchCodexUsageSummaryForAuth(auth);
	return result.summary;
}

export async function fetchCodexUsageSummaryForAuth(
	auth: AuthFile
): Promise<{ summary: CodexUsageSummary; auth: AuthFile; authChanged: boolean }> {
	const result = await fetchUsageWithRefresh(auth);
	return {
		summary: buildUsageSummary(result),
		auth: result.auth,
		authChanged: JSON.stringify(result.auth) !== JSON.stringify(auth),
	};
}

async function fetchUsageWithRefresh(initialAuth: AuthFile): Promise<UsageFetchResult> {
	const firstAttempt = await fetchWhamUsage(initialAuth);
	if (
		(firstAttempt.statusCode === 401 || firstAttempt.statusCode === 403) &&
		initialAuth.tokens?.refresh_token?.trim()
	) {
		const refreshedAuth = await refreshCodexAuthTokens(initialAuth);
		const retryResult = await fetchWhamUsage(refreshedAuth);
		return {
			...retryResult,
			auth: refreshedAuth,
		};
	}

	return firstAttempt;
}

async function fetchWhamUsage(auth: AuthFile): Promise<UsageFetchResult> {
	const accessToken = auth.tokens?.access_token?.trim() ?? '';
	const accountId = auth.tokens?.account_id?.trim() ?? '';
	if (!accessToken) {
		throw new Error('当前账号缺少 access_token。');
	}
	if (!accountId) {
		throw new Error('当前账号缺少 account_id。');
	}

	const response = await fetch(`${CHATGPT_BASE}/backend-api/wham/usage`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'chatgpt-account-id': accountId,
			Accept: 'application/json',
			originator: 'codex_cli_rs',
		},
	});

	let body: unknown;
	try {
		body = (await response.json()) as unknown;
	} catch {
		body = await response.text();
	}

	return {
		statusCode: response.status,
		body,
		auth,
	};
}

function buildUsageSummary(result: UsageFetchResult): CodexUsageSummary {
	const payload = isRecord(result.body) ? (result.body as UsageResponsePayload) : null;
	const rateLimit = isRecord(payload?.rate_limit) ? payload.rate_limit : {};
	const windows = resolveRateLimitWindows(payload);
	const planType = stringOrNull(payload?.plan_type) ?? stringOrNull(rateLimit.plan_type);
	const isAvailable =
		typeof rateLimit.allowed === 'boolean' && typeof rateLimit.limit_reached === 'boolean'
			? rateLimit.allowed && !rateLimit.limit_reached
			: null;

	return {
		planType,
		isAvailable,
		upstreamStatus: result.statusCode,
		email: stringOrNull(payload?.email),
		accountId: stringOrNull(payload?.account_id) ?? result.auth.tokens?.account_id ?? null,
		userId: stringOrNull(payload?.user_id),
		lastFetchedAt: formatLocalDateTime(new Date()),
		fiveHourWindow: windows.fiveHourWindow,
		weeklyWindow: windows.weeklyWindow,
		message:
			result.statusCode >= 200 && result.statusCode < 300 ? null : `上游状态码: ${result.statusCode}`,
		raw: result.body,
	};
}

function resolveRateLimitWindows(payload: UsageResponsePayload | null): {
	fiveHourWindow: CodexRateLimitWindow | null;
	weeklyWindow: CodexRateLimitWindow | null;
} {
	const rateLimit = isRecord(payload?.rate_limit) ? payload.rate_limit : {};
	const primary = toWindow(rateLimit.primary_window);
	const secondary = toWindow(rateLimit.secondary_window);
	const windows = [primary, secondary].filter((value): value is CodexRateLimitWindow => value !== null);
	const planType = normalizePlanType(payload?.plan_type) ?? normalizePlanType(rateLimit.plan_type);

	let fiveHourWindow: CodexRateLimitWindow | null = null;
	let weeklyWindow: CodexRateLimitWindow | null = null;

	for (const windowData of windows) {
		const seconds = windowData.limitWindowSeconds;
		if (seconds === null) {
			continue;
		}
		if (seconds >= 24 * 60 * 60 && !weeklyWindow) {
			weeklyWindow = windowData;
			continue;
		}
		if (!fiveHourWindow) {
			fiveHourWindow = windowData;
		}
	}

	if (planType === 'free') {
		return {
			fiveHourWindow: null,
			weeklyWindow: weeklyWindow ?? primary ?? secondary,
		};
	}

	if (!fiveHourWindow && !weeklyWindow) {
		return {
			fiveHourWindow: primary,
			weeklyWindow: secondary,
		};
	}

	return {
		fiveHourWindow: fiveHourWindow ?? windows.find((value) => value !== weeklyWindow) ?? null,
		weeklyWindow: weeklyWindow ?? windows.find((value) => value !== fiveHourWindow) ?? null,
	};
}

function toWindow(value: unknown): CodexRateLimitWindow | null {
	if (!isRecord(value)) {
		return null;
	}

	return {
		usedPercent: numberOrNull(value.used_percent),
		resetAt: formatUnixSeconds(value.reset_at),
		resetAfterSeconds: numberOrNull(value.reset_after_seconds),
		limitWindowSeconds: numberOrNull(value.limit_window_seconds),
	};
}

function formatUnixSeconds(value: unknown): string | null {
	const seconds = numberOrNull(value);
	if (seconds === null || seconds <= 0) {
		return null;
	}

	return formatLocalDateTime(new Date(seconds * 1000));
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePlanType(value: unknown): string | null {
	const text = stringOrNull(value);
	return text ? text.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
