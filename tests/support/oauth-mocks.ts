import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	SignJWT,
} from "jose";
import { vi } from "vitest";
import { assertRegistration } from "../../src/auth/oauth-registration.ts";
import type {
	ProviderEnvironment,
	ProviderIO,
} from "../../src/auth/provider-env.ts";
import {
	providerAuthOptions,
	resolveSignInProviders,
} from "../../src/auth/providers.ts";
import type { RegistrationMode } from "../../src/auth/registration.ts";
import { registrationAPIError } from "../../src/auth/registration-error.ts";

export const BASE = "http://localhost:3000";

export type MockRequest = {
	url: URL;
	method: string;
	headers: Headers;
	form: URLSearchParams;
};
export type MockRoute = (
	request: MockRequest,
) => Response | Promise<Response> | undefined;

// Replaces global fetch for one test. Any outbound request no route claims
// fails the test, so nothing reaches a real provider.
export function mockProviderEndpoints(routes: MockRoute[]) {
	const calls: MockRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : undefined;
			const url = new URL(request ? request.url : input.toString());
			const headers = new Headers(init?.headers ?? request?.headers);
			const raw =
				typeof init?.body === "string"
					? init.body
					: init?.body instanceof URLSearchParams
						? init.body.toString()
						: request
							? await request.clone().text()
							: "";
			const mock: MockRequest = {
				url,
				method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
				headers,
				form: new URLSearchParams(
					headers.get("content-type")?.includes("form") ? raw : "",
				),
			};
			calls.push(mock);
			for (const route of routes) {
				const response = await route(mock);
				if (response) return response;
			}
			throw new Error(`unexpected outbound request ${mock.method} ${url.href}`);
		}),
	);
	return { calls };
}

export const json = (body: unknown, status = 200) =>
	Response.json(body, { status });

export type SigningKey = {
	kid: string;
	jwks: { keys: JWK[] };
	sign(claims: JWTPayload, header?: Record<string, unknown>): Promise<string>;
};

export async function signingKey(kid = "test-key"): Promise<SigningKey> {
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid,
		alg: "RS256",
		use: "sig",
	};
	return {
		kid,
		jwks: { keys: [jwk] },
		sign: (claims, header = {}) =>
			new SignJWT(claims)
				.setProtectedHeader({ alg: "RS256", kid, ...header })
				.sign(privateKey),
	};
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export function memoryAuth(options: {
	env: ProviderEnvironment;
	io?: ProviderIO;
	mode?: RegistrationMode;
	invites?: string[];
}) {
	const store = {
		user: [] as Record<string, unknown>[],
		account: [] as Record<string, unknown>[],
		session: [] as Record<string, unknown>[],
		verification: [] as Record<string, unknown>[],
	};
	const signIn = resolveSignInProviders(options.env, options.io);
	const providers = providerAuthOptions(signIn);
	const mode = options.mode ?? "open";
	const invites = new Set(options.invites ?? []);
	const auth = betterAuth({
		appName: "Ditero",
		baseURL: BASE,
		secret: "provider-journey-test-secret-32-bytes!",
		database: memoryAdapter(store),
		logger: { disabled: true },
		trustedOrigins: providers.trustedOrigins,
		account: providers.account,
		socialProviders: providers.socialProviders,
		plugins: providers.plugins,
		emailAndPassword: { enabled: true },
		databaseHooks: {
			user: {
				create: {
					before: async (user, context) => {
						try {
							await assertRegistration({
								mode,
								path: context?.path,
								email: user.email,
								emailVerified: user.emailVerified === true,
								bypass: false,
								userCount: async () => store.user.length,
								hasInvite: async (email) => invites.has(email),
							});
						} catch (error) {
							throw registrationAPIError(error);
						}
					},
				},
			},
		},
	});
	return { auth, store, signIn };
}

export type TestAuth = ReturnType<typeof memoryAuth>["auth"];
export type AuthHandler = { handler(request: Request): Promise<Response> };

const cookiesOf = (
	response: Response,
	jar: Map<string, string> = new Map(),
) => {
	for (const line of response.headers.getSetCookie()) {
		const [pair] = line.split(";");
		const index = pair.indexOf("=");
		jar.set(pair.slice(0, index), pair.slice(index + 1));
	}
	return jar;
};
const cookieHeader = (jar: Map<string, string>) =>
	[...jar].map(([name, value]) => `${name}=${value}`).join("; ");

export type Started = {
	authorization: URL;
	state: string;
	jar: Map<string, string>;
};

// Begins sign-in (or, with a signed-in jar, account linking) and returns the
// authorization URL the browser would be sent to.
export async function startOAuth(
	auth: AuthHandler,
	provider: string,
	options: {
		callbackURL?: string;
		errorCallbackURL?: string;
		session?: Map<string, string>;
		link?: boolean;
	} = {},
): Promise<Started> {
	const jar = new Map(options.session);
	const response = await auth.handler(
		new Request(
			`${BASE}/api/auth/${options.link ? "link-social" : "sign-in/social"}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: BASE,
					cookie: cookieHeader(jar),
				},
				body: JSON.stringify({
					provider,
					callbackURL: options.callbackURL ?? "/done",
					errorCallbackURL: options.errorCallbackURL ?? "/failed",
				}),
			},
		),
	);
	if (response.status !== 200)
		throw new Error(
			`start failed: ${response.status} ${await response.text()}`,
		);
	cookiesOf(response, jar);
	const authorization = new URL((await response.json()).url);
	return {
		authorization,
		state: authorization.searchParams.get("state") ?? "",
		jar,
	};
}

export type Outcome = {
	status: number;
	location: URL | null;
	error: string | null;
	jar: Map<string, string>;
};

export async function finishOAuth(
	auth: AuthHandler,
	provider: string,
	started: Started,
	options: {
		code?: string;
		form?: boolean;
		origin?: string;
		extra?: Record<string, string>;
	} = {},
): Promise<Outcome> {
	const params = new URLSearchParams({
		code: options.code ?? "auth-code",
		state: started.state,
		...options.extra,
	});
	const url = `${BASE}/api/auth/callback/${provider}`;
	const request = options.form
		? new Request(url, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: options.origin ?? BASE,
					cookie: cookieHeader(started.jar),
				},
				body: params,
			})
		: new Request(`${url}?${params}`, {
				headers: { cookie: cookieHeader(started.jar) },
			});
	const response = await auth.handler(request);
	// A callback always answers with a redirect; anything else is a harness fault
	// (for example an outbound request no route claims), not a refusal.
	if (response.status !== 302 && !options.allowStatus)
		throw new Error(`callback answered ${response.status}`);
	const jar = cookiesOf(response, new Map(started.jar));
	const location = response.headers.get("location");
	const target = location ? new URL(location, BASE) : null;
	return {
		status: response.status,
		location: target,
		error: target?.searchParams.get("error") ?? null,
		jar,
	};
}

// Password account with an active session, for link/refusal journeys.
export async function signedInUser(
	auth: TestAuth,
	email: string,
): Promise<Map<string, string>> {
	await auth.api.signUpEmail({
		body: { email, password: "correct-horse-battery", name: "Existing" },
	});
	const response = await auth.api.signInEmail({
		body: { email, password: "correct-horse-battery" },
		asResponse: true,
	});
	return cookiesOf(response);
}

// A password account whose email is verified: the case in which an automatic
// same-email link would be accepted if implicit linking were still allowed.
export async function verifiedUser(
	harness: { auth: TestAuth; store: { user: Record<string, unknown>[] } },
	email: string,
): Promise<Map<string, string>> {
	const jar = await signedInUser(harness.auth, email);
	for (const user of harness.store.user)
		if (user.email === email) user.emailVerified = true;
	return jar;
}

export const noFiles: ProviderIO = {
	readFile() {
		throw new Error("ENOENT");
	},
};
