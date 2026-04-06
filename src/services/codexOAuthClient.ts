import * as crypto from 'node:crypto';
import { AuthFile } from '../types/auth';

const OPENAI_AUTH_BASE = 'https://auth.openai.com';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const COMMON_HEADERS: Record<string, string> = {
	accept: 'application/json',
	'accept-language': 'en-US,en;q=0.9',
	'content-type': 'application/json',
	origin: OPENAI_AUTH_BASE,
	'user-agent': USER_AGENT,
	'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"',
	'sec-fetch-dest': 'empty',
	'sec-fetch-mode': 'cors',
	'sec-fetch-site': 'same-origin',
};
const NAVIGATE_HEADERS: Record<string, string> = {
	accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
	'accept-language': 'en-US,en;q=0.9',
	'user-agent': USER_AGENT,
	'sec-ch-ua': '"Google Chrome";v="145", "Not?A_Brand";v="8", "Chromium";v="145"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"',
	'sec-fetch-dest': 'document',
	'sec-fetch-mode': 'navigate',
	'sec-fetch-site': 'same-origin',
	'sec-fetch-user': '?1',
	'upgrade-insecure-requests': '1',
};

type OAuthCallbacks = {
	log: (message: string) => void;
	promptPassword: (prompt: string) => Promise<string | undefined>;
	promptOtp: (prompt: string) => Promise<string | undefined>;
};

type RequestOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string | URLSearchParams;
	timeoutMs?: number;
};

type WorkspaceItem = {
	id?: string;
	kind?: string;
};

type ProjectItem = {
	id?: string;
};

type OrganizationItem = {
	id?: string;
	projects?: ProjectItem[];
};

type WorkspaceSelectResponse = {
	continue_url?: string;
	page?: {
		type?: string;
	};
	data?: {
		orgs?: OrganizationItem[];
	};
};

type AuthSessionPayload = {
	workspaces?: WorkspaceItem[];
};

export type CodexOAuthBrowserFlow = {
	state: string;
	codeVerifier: string;
	authorizeUrl: string;
	redirectUri: string;
};

export async function performCodexOAuthLogin(
	email: string,
	password: string,
	callbacks: OAuthCallbacks
): Promise<AuthFile> {
	const session = new HttpSession();
	const deviceId = crypto.randomUUID();
	session.setCookie('oai-did', deviceId);

	const { codeVerifier, codeChallenge } = generatePkce();
	const state = base64UrlEncode(crypto.randomBytes(32));
	const authorizeUrl = `${OPENAI_AUTH_BASE}/oauth/authorize?${new URLSearchParams({
		response_type: 'code',
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
		scope: 'openid profile email offline_access',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state,
	}).toString()}`;

	callbacks.log('步骤1/4: 初始化 OAuth 会话');
	const authorizeResponse = await session.navigate(authorizeUrl, { headers: NAVIGATE_HEADERS });
	callbacks.log(`authorize 返回 ${authorizeResponse.status}`);

	const authorizeHeaders: Record<string, string> = {
		...COMMON_HEADERS,
		referer: `${OPENAI_AUTH_BASE}/log-in`,
		'oai-device-id': deviceId,
		...generateDatadogTrace(),
	};
	const sentinelEmail = await buildSentinelToken(session, deviceId, 'authorize_continue');
	if (!sentinelEmail) {
		throw new Error('无法生成 authorize_continue sentinel token。');
	}
	authorizeHeaders['openai-sentinel-token'] = sentinelEmail;

	callbacks.log('步骤2/4: 提交邮箱');
	const emailResponse = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/authorize/continue`, {
		method: 'POST',
		headers: authorizeHeaders,
		body: JSON.stringify({ username: { kind: 'email', value: email } }),
	});
	if (emailResponse.status !== 200) {
		throw new Error(`邮箱提交失败: ${emailResponse.status} ${trimForError(await emailResponse.text())}`);
	}

	const passwordHeaders: Record<string, string> = {
		...authorizeHeaders,
		referer: `${OPENAI_AUTH_BASE}/log-in/password`,
		...generateDatadogTrace(),
	};
	const sentinelPassword = await buildSentinelToken(session, deviceId, 'password_verify');
	if (!sentinelPassword) {
		throw new Error('无法生成 password_verify sentinel token。');
	}
	passwordHeaders['openai-sentinel-token'] = sentinelPassword;

	callbacks.log('步骤3/4: 提交密码');
	const passwordResponse = await verifyPasswordWithRetry(session, passwordHeaders, password, callbacks);

	const passwordPayload = (await safeJson(passwordResponse)) as {
		continue_url?: string;
		page?: { type?: string };
	};
	let continueUrl = passwordPayload.continue_url ?? '';
	let pageType = passwordPayload.page?.type ?? '';

	if (!continueUrl) {
		throw new Error('登录后未获取到 continue_url。');
	}

	if (pageType === 'email_otp_verification' || continueUrl.includes('email-verification')) {
		callbacks.log('检测到邮箱验证码校验');
		continueUrl = await handleOtpVerification(session, deviceId, email, continueUrl, callbacks);
		pageType = continueUrl.includes('consent') ? 'consent' : pageType;
	}

	if (pageType.includes('consent')) {
		continueUrl = `${OPENAI_AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
	}
	if (!continueUrl) {
		throw new Error('未拿到 consent 继续地址。');
	}

	const consentUrl = absolutizeUrl(continueUrl);
	callbacks.log('步骤4/4: 处理 consent 并换取 token');
	const authCode = await resolveAuthorizationCode(session, deviceId, consentUrl, callbacks);
	if (!authCode) {
		throw new Error('未获取到 authorization code。');
	}

	const tokens = await exchangeAuthorizationCode(authCode, codeVerifier, callbacks);
	return buildAuthFile(email, tokens);
}

export function createCodexOAuthBrowserFlow(): CodexOAuthBrowserFlow {
	const { codeVerifier, codeChallenge } = generatePkce();
	const state = base64UrlEncode(crypto.randomBytes(32));
	const authorizeUrl = `${OPENAI_AUTH_BASE}/oauth/authorize?${new URLSearchParams({
		response_type: 'code',
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: OAUTH_REDIRECT_URI,
		scope: 'openid profile email offline_access',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state,
		id_token_add_organizations: 'true',
		codex_cli_simplified_flow: 'true',
		originator: 'codex_cli_rs',
	}).toString()}`;

	return {
		state,
		codeVerifier,
		authorizeUrl,
		redirectUri: OAUTH_REDIRECT_URI,
	};
}

export async function completeCodexOAuthBrowserFlow(
	callbackUrlOrQuery: string,
	flow: CodexOAuthBrowserFlow
): Promise<AuthFile> {
	const parsed = parseCodexAuthorizationInput(callbackUrlOrQuery);
	if (!parsed.code) {
		throw new Error('回调 URL 中缺少 code。');
	}
	if (!parsed.state) {
		throw new Error('回调 URL 中缺少 state。');
	}
	if (parsed.state !== flow.state) {
		throw new Error('state 校验失败，请重新开始网页登录。');
	}

	const tokens = await exchangeAuthorizationCode(parsed.code, flow.codeVerifier, {
		log: () => {},
		promptOtp: async () => undefined,
		promptPassword: async () => undefined,
	});
	return buildAuthFile(null, tokens);
}

export async function refreshCodexAuthTokens(auth: AuthFile): Promise<AuthFile> {
	const refreshToken = auth.tokens?.refresh_token?.trim() ?? '';
	if (!refreshToken) {
		throw new Error('当前账号缺少 refresh_token。');
	}

	const response = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: OAUTH_CLIENT_ID,
		}),
	});
	if (!response.ok) {
		throw new Error(`刷新授权失败: ${response.status} ${trimForError(await response.text())}`);
	}

	const tokens = (await response.json()) as Record<string, unknown>;
	return buildAuthFileFromExisting(auth, tokens);
}

class HttpSession {
	private readonly cookies = new Map<string, string>();

	setCookie(name: string, value: string): void {
		this.cookies.set(name, value);
	}

	getCookie(name: string): string | undefined {
		return this.cookies.get(name);
	}

	async request(url: string, options: RequestOptions = {}): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
		try {
			const headers = new Headers(options.headers ?? {});
			const cookieHeader = this.buildCookieHeader(url);
			if (cookieHeader) {
				headers.set('cookie', cookieHeader);
			}
			const response = await fetch(url, {
				method: options.method ?? 'GET',
				headers,
				body: options.body,
				redirect: 'manual',
				signal: controller.signal,
			});
			this.captureSetCookies(response.headers);
			return response;
		} finally {
			clearTimeout(timeout);
		}
	}

	async navigate(url: string, options: RequestOptions = {}, maxRedirects = 10): Promise<Response> {
		let currentUrl = url;
		let method = options.method ?? 'GET';
		let body = options.body;
		let headers = options.headers;
		let response: Response | undefined;

		for (let depth = 0; depth <= maxRedirects; depth += 1) {
			response = await this.request(currentUrl, {
				...options,
				method,
				headers,
				body,
			});
			if (!isRedirectStatus(response.status)) {
				return response;
			}

			const location = response.headers.get('location');
			if (!location) {
				return response;
			}

			currentUrl = absolutizeUrl(location, currentUrl);
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET')) {
				method = 'GET';
				body = undefined;
			}
		}

		if (!response) {
			throw new Error('导航失败。');
		}
		return response;
	}

	private buildCookieHeader(url: string): string {
		const host = new URL(url).hostname;
		if (!host.endsWith('openai.com')) {
			return '';
		}

		return Array.from(this.cookies.entries())
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}

	private captureSetCookies(headers: Headers): void {
		const setCookies = getSetCookies(headers);
		for (const cookie of setCookies) {
			const [nameValue] = cookie.split(';');
			const separator = nameValue.indexOf('=');
			if (separator <= 0) {
				continue;
			}

			const name = nameValue.slice(0, separator).trim();
			const value = nameValue.slice(separator + 1).trim();
			if (!name) {
				continue;
			}

			this.cookies.set(name, value);
		}
	}
}

class SentinelTokenGenerator {
	private static readonly maxAttempts = 500000;
	private static readonly errorPrefix = 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D';
	private readonly requirementsSeed = String(Math.random());
	private readonly sid = crypto.randomUUID();

	constructor(private readonly deviceId: string) {}

	generateToken(seed?: string, difficulty?: string): string {
		const actualSeed = seed ?? this.requirementsSeed;
		const actualDifficulty = difficulty ?? '0';
		const config = this.getConfig();
		const startedAt = Date.now();

		for (let nonce = 0; nonce < SentinelTokenGenerator.maxAttempts; nonce += 1) {
			const result = this.runCheck(startedAt, actualSeed, actualDifficulty, config, nonce);
			if (result) {
				return `gAAAAAB${result}`;
			}
		}

		return `gAAAAAB${SentinelTokenGenerator.errorPrefix}${this.base64Encode(String(null))}`;
	}

	generateRequirementsToken(): string {
		const config = this.getConfig();
		config[3] = 1;
		config[9] = Math.round(randomBetween(5, 50));
		return `gAAAAAC${this.base64Encode(config)}`;
	}

	private runCheck(startedAt: number, seed: string, difficulty: string, config: unknown[], nonce: number): string | null {
		config[3] = nonce;
		config[9] = Math.round(Date.now() - startedAt);
		const data = this.base64Encode(config);
		const hashHex = this.fnv1a32(`${seed}${data}`);
		if (hashHex.slice(0, difficulty.length) <= difficulty) {
			return `${data}~S`;
		}
		return null;
	}

	private getConfig(): unknown[] {
		const now = new Date();
		const utcString = formatUtcDateString(now);
		const perfNow = randomBetween(1000, 50000);
		const timeOrigin = Date.now() - perfNow;
		const navProp = randomChoice([
			'vendorSub',
			'productSub',
			'vendor',
			'maxTouchPoints',
			'scheduling',
			'userActivation',
			'doNotTrack',
			'geolocation',
			'connection',
			'plugins',
			'mimeTypes',
			'pdfViewerEnabled',
			'webkitTemporaryStorage',
			'webkitPersistentStorage',
			'hardwareConcurrency',
			'cookieEnabled',
			'credentials',
			'mediaDevices',
			'permissions',
			'locks',
			'ink',
		]);

		return [
			'1920x1080',
			utcString,
			4294705152,
			Math.random(),
			USER_AGENT,
			'https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js',
			null,
			null,
			'en-US',
			'en-US,en',
			Math.random(),
			`${navProp}-undefined`,
			randomChoice(['location', 'implementation', 'URL', 'documentURI', 'compatMode']),
			randomChoice(['Object', 'Function', 'Array', 'Number', 'parseFloat', 'undefined']),
			perfNow,
			this.sid,
			'',
			randomChoice([4, 8, 12, 16]),
			timeOrigin,
		];
	}

	private base64Encode(data: unknown): string {
		return Buffer.from(JSON.stringify(data, undefined, 0), 'utf8').toString('base64');
	}

	private fnv1a32(text: string): string {
		let hash = 2166136261;
		for (const character of text) {
			hash ^= character.charCodeAt(0);
			hash = Math.imul(hash, 16777619) >>> 0;
		}
		hash ^= hash >>> 16;
		hash = Math.imul(hash, 2246822507) >>> 0;
		hash ^= hash >>> 13;
		hash = Math.imul(hash, 3266489909) >>> 0;
		hash ^= hash >>> 16;
		return (hash >>> 0).toString(16).padStart(8, '0');
	}
}

async function handleOtpVerification(
	session: HttpSession,
	deviceId: string,
	email: string,
	initialContinueUrl: string,
	callbacks: OAuthCallbacks
): Promise<string> {
	const verifyHeaders = {
		...COMMON_HEADERS,
		referer: `${OPENAI_AUTH_BASE}/email-verification`,
		'oai-device-id': deviceId,
		...generateDatadogTrace(),
	};

	const otpPayload = await verifyOtpWithRetry(session, email, verifyHeaders, callbacks);
	let continueUrl = otpPayload.continue_url ?? initialContinueUrl;

	if (continueUrl.includes('about-you')) {
		callbacks.log('检测到 about-you，自动补全资料');
		const aboutResponse = await session.navigate(`${OPENAI_AUTH_BASE}/about-you`, {
			headers: {
				...NAVIGATE_HEADERS,
				referer: `${OPENAI_AUTH_BASE}/email-verification`,
			},
		});
		if (aboutResponse.url.includes('consent') || aboutResponse.url.includes('organization')) {
			return aboutResponse.url;
		}

		const createResponse = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/create_account`, {
			method: 'POST',
			headers: {
				...COMMON_HEADERS,
				referer: `${OPENAI_AUTH_BASE}/about-you`,
				'oai-device-id': deviceId,
				...generateDatadogTrace(),
			},
			body: JSON.stringify({
				name: randomName(),
				birthdate: randomBirthdate(),
			}),
		});
		if (createResponse.status === 200) {
			const createPayload = (await safeJson(createResponse)) as { continue_url?: string };
			continueUrl = createPayload.continue_url ?? continueUrl;
		} else {
			const createText = await createResponse.text();
			if (createResponse.status === 400 && createText.includes('already_exists')) {
				return `${OPENAI_AUTH_BASE}/sign-in-with-chatgpt/codex/consent`;
			}
		}
	}

	return continueUrl;
}

async function verifyPasswordWithRetry(
	session: HttpSession,
	headers: Record<string, string>,
	initialPassword: string,
	callbacks: OAuthCallbacks
): Promise<Response> {
	let currentPassword = initialPassword;

	while (true) {
		const response = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/password/verify`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ password: currentPassword }),
		});
		if (response.status === 200) {
			return response;
		}

		const errorText = await response.text();
		if (!isRetryablePasswordError(response.status, errorText)) {
			throw new Error(`密码验证失败: ${response.status} ${trimForError(errorText)}`);
		}

		callbacks.log(`密码错误，等待重新输入: ${trimForError(errorText)}`);
		const nextPassword = await callbacks.promptPassword('密码错误，请重新输入 Codex 账号密码');
		if (!nextPassword) {
			throw new Error('已取消重新输入密码。');
		}
		currentPassword = nextPassword;
	}
}

async function verifyOtpWithRetry(
	session: HttpSession,
	email: string,
	verifyHeaders: Record<string, string>,
	callbacks: OAuthCallbacks
): Promise<{
	continue_url?: string;
	page?: { type?: string };
}> {
	while (true) {
		const code = await callbacks.promptOtp(`输入发送到 ${email} 的 6 位邮箱验证码`);
		if (!code) {
			throw new Error('已取消输入验证码。');
		}

		const otpResponse = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/email-otp/validate`, {
			method: 'POST',
			headers: verifyHeaders,
			body: JSON.stringify({ code }),
		});
		if (otpResponse.status === 200) {
			return (await safeJson(otpResponse)) as {
				continue_url?: string;
				page?: { type?: string };
			};
		}

		const errorText = await otpResponse.text();
		if (isRetryableOtpError(otpResponse.status, errorText)) {
			callbacks.log(`验证码错误，等待重新输入: ${trimForError(errorText)}`);
			continue;
		}

		throw new Error(`验证码校验失败: ${otpResponse.status} ${trimForError(errorText)}`);
	}
}

async function resolveAuthorizationCode(
	session: HttpSession,
	deviceId: string,
	consentUrl: string,
	callbacks: OAuthCallbacks
): Promise<string | null> {
	let authCode = await getCodeFromConsentEntry(session, consentUrl);
	if (authCode) {
		return authCode;
	}

	const sessionPayload = decodeAuthSession(session.getCookie('oai-client-auth-session'));
	const workspaceId = sessionPayload?.workspaces?.[0]?.id;
	if (workspaceId) {
		callbacks.log(`workspace_id: ${workspaceId}`);
		const workspaceResponse = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/workspace/select`, {
			method: 'POST',
			headers: {
				...COMMON_HEADERS,
				referer: consentUrl,
				'oai-device-id': deviceId,
				...generateDatadogTrace(),
			},
			body: JSON.stringify({ workspace_id: workspaceId }),
		});
		authCode = await resolveCodeFromWorkspaceResponse(session, deviceId, workspaceResponse);
		if (authCode) {
			return authCode;
		}
	}

	authCode = await followRedirectsForCode(session, consentUrl);
	return authCode;
}

async function getCodeFromConsentEntry(session: HttpSession, consentUrl: string): Promise<string | null> {
	const response = await session.request(consentUrl, {
		headers: NAVIGATE_HEADERS,
	});
	if (!isRedirectStatus(response.status)) {
		return null;
	}

	const location = response.headers.get('location');
	if (!location) {
		return null;
	}

	return extractCodeFromUrl(location) ?? followRedirectsForCode(session, absolutizeUrl(location, consentUrl));
}

async function resolveCodeFromWorkspaceResponse(
	session: HttpSession,
	deviceId: string,
	response: Response
): Promise<string | null> {
	if (isRedirectStatus(response.status)) {
		const location = response.headers.get('location');
		if (!location) {
			return null;
		}
		return extractCodeFromUrl(location) ?? followRedirectsForCode(session, absolutizeUrl(location));
	}

	if (response.status !== 200) {
		return null;
	}

	const workspacePayload = (await safeJson(response)) as WorkspaceSelectResponse;
	const nextUrl = workspacePayload.continue_url;
	const organizations = workspacePayload.data?.orgs ?? [];
	const firstOrganization = organizations[0];
	const orgId = firstOrganization?.id;
	const projectId = firstOrganization?.projects?.[0]?.id;

	if (orgId) {
		const organizationUrl = absolutizeUrl(nextUrl ?? `${OPENAI_AUTH_BASE}/organization`);
		const body: Record<string, string> = { org_id: orgId };
		if (projectId) {
			body.project_id = projectId;
		}
		const organizationResponse = await session.request(`${OPENAI_AUTH_BASE}/api/accounts/organization/select`, {
			method: 'POST',
			headers: {
				...COMMON_HEADERS,
				referer: organizationUrl,
				'oai-device-id': deviceId,
				...generateDatadogTrace(),
			},
			body: JSON.stringify(body),
		});
		if (isRedirectStatus(organizationResponse.status)) {
			const location = organizationResponse.headers.get('location');
			if (!location) {
				return null;
			}
			return extractCodeFromUrl(location) ?? followRedirectsForCode(session, absolutizeUrl(location, organizationUrl));
		}
		if (organizationResponse.status === 200) {
			const organizationPayload = (await safeJson(organizationResponse)) as { continue_url?: string };
			if (organizationPayload.continue_url) {
				return followRedirectsForCode(session, absolutizeUrl(organizationPayload.continue_url, organizationUrl));
			}
		}
	}

	if (nextUrl) {
		return followRedirectsForCode(session, absolutizeUrl(nextUrl));
	}

	return null;
}

async function exchangeAuthorizationCode(
	code: string,
	codeVerifier: string,
	callbacks: OAuthCallbacks
): Promise<Record<string, unknown>> {
	callbacks.log('执行 oauth/token 交换');
	const response = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: OAUTH_REDIRECT_URI,
			client_id: OAUTH_CLIENT_ID,
			code_verifier: codeVerifier,
		}),
	});
	if (!response.ok) {
		throw new Error(`oauth/token 失败: ${response.status} ${trimForError(await response.text())}`);
	}
	return (await response.json()) as Record<string, unknown>;
}

async function buildSentinelToken(session: HttpSession, deviceId: string, flow: string): Promise<string | null> {
	const generator = new SentinelTokenGenerator(deviceId);
	const challengeResponse = await fetch('https://sentinel.openai.com/backend-api/sentinel/req', {
		method: 'POST',
		headers: {
			'Content-Type': 'text/plain;charset=UTF-8',
			Referer: 'https://sentinel.openai.com/backend-api/sentinel/frame.html',
			'User-Agent': USER_AGENT,
			Origin: 'https://sentinel.openai.com',
			'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
			'sec-ch-ua-mobile': '?0',
			'sec-ch-ua-platform': '"Windows"',
		},
		body: JSON.stringify({
			p: generator.generateRequirementsToken(),
			id: deviceId,
			flow,
		}),
	});
	if (!challengeResponse.ok) {
		return null;
	}

	const challengePayload = (await challengeResponse.json()) as {
		token?: string;
		proofofwork?: {
			required?: boolean;
			seed?: string;
			difficulty?: string;
		};
	};

	const proof = challengePayload.proofofwork;
	const pValue =
		proof?.required && proof.seed
			? generator.generateToken(proof.seed, proof.difficulty ?? '0')
			: generator.generateRequirementsToken();

	return JSON.stringify({
		p: pValue,
		t: '',
		c: challengePayload.token ?? '',
		id: deviceId,
		flow,
	});
}

async function followRedirectsForCode(
	session: HttpSession,
	initialUrl: string,
	maxDepth = 10
): Promise<string | null> {
	let currentUrl = initialUrl;

	for (let depth = 0; depth < maxDepth; depth += 1) {
		const response = await session.request(currentUrl, {
			headers: NAVIGATE_HEADERS,
		});
		if (isRedirectStatus(response.status)) {
			const location = response.headers.get('location');
			if (!location) {
				return null;
			}
			const code = extractCodeFromUrl(location);
			if (code) {
				return code;
			}
			currentUrl = absolutizeUrl(location, currentUrl);
			continue;
		}

		return extractCodeFromUrl(response.url);
	}

	return null;
}

function buildAuthFile(_email: string | null, tokens: Record<string, unknown>): AuthFile {
	return buildAuthFileFromExisting(
		{
			auth_mode: 'chatgpt',
			OPENAI_API_KEY: '',
		},
		tokens
	);
}

function buildAuthFileFromExisting(existingAuth: AuthFile, tokens: Record<string, unknown>): AuthFile {
	const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
	const refreshToken =
		typeof tokens.refresh_token === 'string' && tokens.refresh_token
			? tokens.refresh_token
			: existingAuth.tokens?.refresh_token ?? '';
	const idToken =
		typeof tokens.id_token === 'string' && tokens.id_token
			? tokens.id_token
			: existingAuth.tokens?.id_token ?? '';
	const payload = decodeJwtPayload(accessToken);
	const authClaims = isRecord(payload['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'] : {};
	const accountId =
		typeof authClaims.chatgpt_account_id === 'string' && authClaims.chatgpt_account_id
			? authClaims.chatgpt_account_id
			: existingAuth.tokens?.account_id ?? '';

	return {
		auth_mode: existingAuth.auth_mode ?? 'chatgpt',
		OPENAI_API_KEY: existingAuth.OPENAI_API_KEY ?? '',
		tokens: {
			id_token: idToken,
			access_token: accessToken,
			refresh_token: refreshToken,
			account_id: accountId,
		},
		last_refresh: formatOffsetNow(),
	};
}

function decodeAuthSession(cookieValue: string | undefined): AuthSessionPayload | null {
	if (!cookieValue) {
		return null;
	}

	const firstPart = cookieValue.split('.')[0] ?? '';
	try {
		return JSON.parse(Buffer.from(padBase64(firstPart), 'base64url').toString('utf8')) as AuthSessionPayload;
	} catch {
		return null;
	}
}

function decodeJwtPayload(token: string): Record<string, unknown> {
	try {
		const payload = token.split('.')[1];
		if (!payload) {
			return {};
		}
		return JSON.parse(Buffer.from(padBase64(payload), 'base64url').toString('utf8')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function parseCodexAuthorizationInput(input: string): { code: string | null; state: string | null } {
	const value = input.trim();
	if (!value) {
		return { code: null, state: null };
	}

	try {
		const parsedUrl = new URL(value, OPENAI_AUTH_BASE);
		return {
			code: parsedUrl.searchParams.get('code'),
			state: parsedUrl.searchParams.get('state'),
		};
	} catch {
		const query = new URLSearchParams(value);
		return {
			code: query.get('code'),
			state: query.get('state'),
		};
	}
}

function padBase64(value: string): string {
	const remainder = value.length % 4;
	if (remainder === 0) {
		return value;
	}
	return `${value}${'='.repeat(4 - remainder)}`;
}

function extractCodeFromUrl(url: string): string | null {
	if (!url.includes('code=')) {
		return null;
	}
	try {
		const parsedUrl = new URL(url, OPENAI_AUTH_BASE);
		return parsedUrl.searchParams.get('code');
	} catch {
		return null;
	}
}

function absolutizeUrl(url: string, base = OPENAI_AUTH_BASE): string {
	try {
		return new URL(url, base).toString();
	} catch {
		return url;
	}
}

function getSetCookies(headers: Headers): string[] {
	const headerBag = headers as Headers & {
		getSetCookie?: () => string[];
		raw?: () => Record<string, string[]>;
	};

	if (typeof headerBag.getSetCookie === 'function') {
		return headerBag.getSetCookie();
	}
	if (typeof headerBag.raw === 'function') {
		return headerBag.raw()['set-cookie'] ?? [];
	}

	const merged = headers.get('set-cookie');
	return merged ? splitCombinedSetCookieHeader(merged) : [];
}

function splitCombinedSetCookieHeader(value: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inExpires = false;

	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		const next = value.slice(index, index + 8).toLowerCase();
		if (next === 'expires=') {
			inExpires = true;
		}
		if (char === ',' && !inExpires) {
			parts.push(current.trim());
			current = '';
			continue;
		}
		if (inExpires && char === ';') {
			inExpires = false;
		}
		current += char;
	}
	if (current.trim()) {
		parts.push(current.trim());
	}
	return parts;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = base64UrlEncode(crypto.randomBytes(64));
	const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());
	return { codeVerifier, codeChallenge };
}

function base64UrlEncode(value: Uint8Array | Buffer): string {
	return Buffer.from(value).toString('base64url');
}

function generateDatadogTrace(): Record<string, string> {
	const traceId = randomBigInt64().toString();
	const parentId = randomBigInt64().toString();
	const traceHex = BigInt(traceId).toString(16).padStart(16, '0');
	const parentHex = BigInt(parentId).toString(16).padStart(16, '0');
	return {
		traceparent: `00-0000000000000000${traceHex}-${parentHex}-01`,
		tracestate: 'dd=s:1;o:rum',
		'x-datadog-origin': 'rum',
		'x-datadog-parent-id': parentId,
		'x-datadog-sampling-priority': '1',
		'x-datadog-trace-id': traceId,
	};
}

function randomBigInt64(): bigint {
	const bytes = crypto.randomBytes(8);
	return bytes.readBigUInt64BE(0);
}

function formatUtcDateString(date: Date): string {
	const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
	const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
		date.getUTCMonth()
	];
	const day = `${date.getUTCDate()}`.padStart(2, '0');
	const year = date.getUTCFullYear();
	const hour = `${date.getUTCHours()}`.padStart(2, '0');
	const minute = `${date.getUTCMinutes()}`.padStart(2, '0');
	const second = `${date.getUTCSeconds()}`.padStart(2, '0');
	return `${weekday} ${month} ${day} ${year} ${hour}:${minute}:${second} GMT+0000 (Coordinated Universal Time)`;
}

function formatOffsetNow(): string {
	const date = new Date();
	const offsetMinutes = 8 * 60;
	const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
	const year = shifted.getUTCFullYear();
	const month = `${shifted.getUTCMonth() + 1}`.padStart(2, '0');
	const day = `${shifted.getUTCDate()}`.padStart(2, '0');
	const hour = `${shifted.getUTCHours()}`.padStart(2, '0');
	const minute = `${shifted.getUTCMinutes()}`.padStart(2, '0');
	const second = `${shifted.getUTCSeconds()}`.padStart(2, '0');
	return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function randomChoice<T>(items: T[]): T {
	return items[Math.floor(Math.random() * items.length)] as T;
}

function randomName(): string {
	return `${randomChoice(['James', 'Mary', 'John', 'Linda', 'Robert', 'Sarah'])} ${randomChoice([
		'Smith',
		'Johnson',
		'Williams',
		'Brown',
		'Jones',
		'Wilson',
	])}`;
}

function randomBirthdate(): string {
	const year = 1995 + Math.floor(Math.random() * 8);
	const month = `${1 + Math.floor(Math.random() * 12)}`.padStart(2, '0');
	const day = `${1 + Math.floor(Math.random() * 28)}`.padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return (await response.json()) as unknown;
	} catch {
		return {};
	}
}

function trimForError(text: string): string {
	return text.slice(0, 200).replace(/\s+/g, ' ').trim();
}

function isRetryableOtpError(status: number, text: string): boolean {
	if (status !== 400 && status !== 401) {
		return false;
	}

	const normalized = text.toLowerCase();
	return (
		normalized.includes('wrong_email_otp_code') ||
		normalized.includes('wrong code') ||
		normalized.includes('invalid code') ||
		normalized.includes('email_otp')
	);
}

function isRetryablePasswordError(status: number, text: string): boolean {
	if (status !== 400 && status !== 401) {
		return false;
	}

	const normalized = text.toLowerCase();
	return (
		normalized.includes('invalid_password') ||
		normalized.includes('wrong password') ||
		normalized.includes('incorrect password') ||
		normalized.includes('password') ||
		normalized.includes('invalid credentials')
	);
}
