import { AsyncLocalStorage } from "node:async_hooks";
import { passkey } from "@better-auth/passkey";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { jwt, twoFactor } from "better-auth/plugins";
import { count, isNull } from "drizzle-orm";
import { validateAuthSecret } from "../config/auth-secret.ts";
import { db, pool } from "../db/client.ts";
import { user } from "../db/schema.ts";
import { createFieldKeyRing } from "../security/field-encryption.ts";
import {
	sanitizeAuthRequest,
	trustedProxyCIDRsFromEnv,
	UNKNOWN_CLIENT_IP,
} from "../server/client-ip.ts";
import { takeRateToken } from "../server/notifications/capability.ts";
import { zeroJwtOptions } from "../server/zero-auth.ts";
import { withAccountConflict } from "./account-conflict.ts";
import { ensurePersonalWorkspace } from "./bootstrap.ts";
import { normalizeDisplayName, signupDisplayName } from "./display-name.ts";
import { withFieldEncryption } from "./encrypted-adapter.ts";
import { emailHasRedeemableInvite } from "./invite-bypass.ts";
import { mailUnavailableResponse, sendAuthMail } from "./mail.ts";
import { assertRegistration } from "./oauth-registration.ts";
import { trustedAuthOrigins } from "./origins.ts";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-policy.ts";
import {
	assertPasswordResetScope,
	RESET_PATH,
	resetLinkWithWebCallback,
	runPasswordReset,
	withPasswordResetTransaction,
} from "./password-reset.ts";

import {
	acceptedAuthOrigins,
	providerAuthOptions,
	resolveSignInProviders,
} from "./providers.ts";
import { resolveRegistrationMode } from "./registration.ts";
import { registrationBypassActive } from "./registration-bypass.ts";
import { registrationAPIError } from "./registration-error.ts";
import {
	authRateLimitOptions,
	passkeyOptions,
	readSignInEmail,
	requireSameOrigin,
	SIGN_IN_RATE_CAPACITY,
	SIGN_IN_RATE_REFILL_PER_SEC,
	signInRateKey,
} from "./security.ts";

export const SIGN_UP_RESPONSE_FLOOR_MS = 500;

type PublicSignUpState = { creating: boolean; error?: APIError };
const publicSignUp = new AsyncLocalStorage<PublicSignUpState>();

const REGISTRATION_LOCK_KEY = 6_794_321;
const registrationMode = resolveRegistrationMode(process.env);
const signIn = resolveSignInProviders(process.env);
const providerOptions = providerAuthOptions(signIn);
const authOrigins = [
	process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
	...trustedAuthOrigins(process.env),
];
const trustedProxies = trustedProxyCIDRsFromEnv(
	process.env.DITERO_TRUSTED_PROXIES,
);
validateAuthSecret();
const encryptionKey = process.env.DITERO_ENCRYPTION_KEY;
if (process.env.NODE_ENV === "production" && !encryptionKey) {
	throw new Error("DITERO_ENCRYPTION_KEY is required in production");
}
const fieldKeyRing = encryptionKey
	? createFieldKeyRing({
			current: encryptionKey,
			next: process.env.DITERO_ENCRYPTION_KEY_NEXT,
		})
	: null;
const authDatabase = withPasswordResetTransaction((database) => {
	const authAdapter = drizzleAdapter(database, { provider: "pg" });
	return withAccountConflict(
		fieldKeyRing ? withFieldEncryption(authAdapter, fieldKeyRing) : authAdapter,
	);
}, db);

async function assertEmailRegistrationAllowed(
	email: string,
	path?: string,
	emailVerified = false,
): Promise<void> {
	await assertRegistration({
		mode: registrationMode,
		path,
		email,
		emailVerified,
		bypass: registrationBypassActive(),
		userCount: registeredUserCount,
		hasInvite: (address) =>
			emailHasRedeemableInvite(address.toLowerCase(), db, Date.now()),
	});
}

async function registeredUserCount(): Promise<number> {
	const [result] = await db
		.select({ value: count() })
		.from(user)
		.where(isNull(user.deletedAt));
	return result.value;
}

function validDisplayName(normalize: () => string): string {
	try {
		return normalize();
	} catch {
		throw new APIError("BAD_REQUEST", {
			code: "INVALID_DISPLAY_NAME",
			message:
				"Use 1-80 characters without control characters for your display name",
		});
	}
}

export const auth = betterAuth({
	appName: "Ditero",
	database: authDatabase,
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	trustedOrigins: (request) => [
		...trustedAuthOrigins(process.env),
		...providerOptions.trustedOrigins(request),
	],
	account: providerOptions.account,
	emailAndPassword: {
		enabled: true,
		autoSignIn: false,
		minPasswordLength: PASSWORD_MIN_LENGTH,
		maxPasswordLength: PASSWORD_MAX_LENGTH,
		// A reset means the old password may be compromised: end every session of
		// the account, which also ends sync access (the Zero token path rechecks
		// the live session). password-reset.ts revokes the other credentials.
		revokeSessionsOnPasswordReset: true,
		sendResetPassword: async ({ user, url }) => {
			sendAuthMail("reset", user, resetLinkWithWebCallback(url));
		},
	},
	// requireEmailVerification stays off deliberately. It is the one setting
	// that could turn a broken SMTP server into permanently unusable accounts,
	// which is not a default a self-hoster can recover from. Verification is
	// offered, not enforced.
	emailVerification: {
		sendOnSignUp: true,
		sendVerificationEmail: async ({ user, url }) => {
			sendAuthMail("verify", user, url);
		},
	},
	rateLimit: authRateLimitOptions(),
	advanced: {
		ipAddress: { ipAddressHeaders: ["x-ditero-client-ip"] },
	},
	socialProviders: providerOptions.socialProviders,
	hooks: {
		before: createAuthMiddleware(async (context) => {
			if (context.path === "/reset-password") assertPasswordResetScope();
			if (context.path !== "/sign-up/email") return;
			if (!context.body || typeof context.body !== "object") return;
			// Public signup accepts only identity and password. In particular, avatar,
			// callback and future additional fields must never reach a new-user insert.
			for (const key of Object.keys(context.body)) {
				if (!["name", "email", "password"].includes(key))
					delete context.body[key];
			}
			const { password, email, name } = context.body;
			// Let Better Auth report input errors before any account lookup.
			if (
				typeof password !== "string" ||
				password.length < PASSWORD_MIN_LENGTH ||
				password.length > PASSWORD_MAX_LENGTH ||
				typeof email !== "string"
			)
				return;
			context.body.name = validDisplayName(() =>
				signupDisplayName(name, email),
			);
			try {
				// The create hook alone runs only for new accounts, leaking existence.
				await assertEmailRegistrationAllowed(email);
			} catch (error) {
				await context.context.password.hash(password);
				throw registrationAPIError(error);
			}
		}),
		after: createAuthMiddleware(async (context) => {
			const state = publicSignUp.getStore();
			if (state?.creating && context.context.returned instanceof APIError)
				state.error = context.context.returned;
		}),
	},
	databaseHooks: {
		user: {
			update: {
				before: async (data) =>
					typeof data.name === "undefined"
						? undefined
						: {
								data: {
									...data,
									name: validDisplayName(() =>
										normalizeDisplayName(data.name as string),
									),
								},
							},
			},
			create: {
				before: async (newUser, context) => {
					const signUp = publicSignUp.getStore();
					if (signUp && context?.path === "/sign-up/email")
						signUp.creating = true;
					const name = validDisplayName(() =>
						signupDisplayName(newUser.name, newUser.email),
					);
					try {
						await assertEmailRegistrationAllowed(
							newUser.email,
							context?.path,
							newUser.emailVerified === true,
						);
					} catch (error) {
						throw registrationAPIError(error);
					}
					return { data: { ...newUser, name } };
				},
				after: async (user) => {
					try {
						await ensurePersonalWorkspace(user);
					} catch (error) {
						console.error("personal workspace provisioning failed", error);
					}
				},
			},
		},
	},
	// jwt plugin exposes /api/auth/token and JWKS at /api/auth/jwks; the Zero
	// token lifetime, issuer and audience are pinned in zero-auth.ts.
	plugins: [
		{
			id: "sign-in-identity-rate-limit",
			async onRequest(request: Request) {
				if (
					request.method === "POST" &&
					new URL(request.url).pathname.replace(/\/+$/, "") ===
						"/api/auth/sign-in/email"
				) {
					const email = await readSignInEmail(request);
					if (email === null)
						return {
							response: Response.json(
								{ message: "Invalid sign-in request", code: "INVALID_BODY" },
								{ status: 400 },
							),
						};
					// No account lookup: existing and unknown addresses consume identical buckets.
					if (
						!(await takeRateToken(
							db,
							signInRateKey(
								request.headers.get("x-ditero-client-ip") ?? UNKNOWN_CLIENT_IP,
								email,
							),
							SIGN_IN_RATE_CAPACITY,
							SIGN_IN_RATE_REFILL_PER_SEC,
						))
					) {
						return {
							response: Response.json(
								{
									message: "Too many requests. Please try again later.",
									code: "TOO_MANY_REQUESTS",
								},
								{ status: 429, headers: { "retry-after": "12" } },
							),
						};
					}
				}
			},
		},
		...providerOptions.plugins,
		passkey(
			passkeyOptions({
				BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
				DITERO_PASSKEY_ORIGIN: process.env.DITERO_PASSKEY_ORIGIN,
				DITERO_PASSKEY_RP_ID: process.env.DITERO_PASSKEY_RP_ID,
			}),
		),
		twoFactor({
			issuer: "Ditero",
			allowPasswordless: true,
			accountLockout: {
				enabled: true,
				maxFailedAttempts: 5,
				durationSeconds: 15 * 60,
			},
		}),
		jwt({ jwt: zeroJwtOptions() }),
	],
});

export async function handleAuthRequest(
	request: Request,
	peerAddress?: string,
): Promise<Response> {
	const path = new URL(request.url).pathname.replace(/\/+$/, "");
	if (request.method === "POST" && path === RESET_PATH)
		return runPasswordReset(() =>
			handleAuthRequestInternal(request, peerAddress),
		);
	const signUp =
		request.method === "POST" && path === "/api/auth/sign-up/email";
	const started = performance.now();
	if (!signUp) return handleAuthRequestInternal(request, peerAddress);
	const state: PublicSignUpState = { creating: false };
	const response = await publicSignUp.run(state, async () => {
		try {
			const result = await handleAuthRequestInternal(request, peerAddress);
			if (!result.ok && state.creating) {
				// Better Auth logs the underlying adapter error; retain an operator signal
				// even when a later persistence step reports only an HTTP failure.
				console.error(
					"Email sign-up persistence failed",
					state.error ?? { status: result.status },
				);
			}
			return result;
		} catch (error) {
			if (!state.creating) throw error;
			console.error("Email sign-up persistence failed", error);
			return new Response(null, { status: 500 });
		}
	});
	await new Promise((resolve) =>
		setTimeout(
			resolve,
			Math.max(0, SIGN_UP_RESPONSE_FLOOR_MS - (performance.now() - started)),
		),
	);
	// No real or synthetic user metadata, and no session on either path.
	if (response.ok || state.creating)
		return Response.json(
			{ token: null, user: null },
			{
				headers: { "cache-control": "no-store" },
			},
		);
	return response;
}

async function handleAuthRequestInternal(
	request: Request,
	peerAddress?: string,
): Promise<Response> {
	request = sanitizeAuthRequest(request, peerAddress, trustedProxies);
	if (
		request.method !== "GET" &&
		(request.headers.has("origin") || request.headers.has("cookie"))
	) {
		try {
			requireSameOrigin(
				request,
				acceptedAuthOrigins(
					request,
					authOrigins,
					Boolean(signIn.settings.apple),
				),
			);
		} catch {
			// This guard fires ahead of Better Auth, so its own INVALID_ORIGIN is
			// never reached; answer in the same JSON shape and reuse the code, or
			// the client has nothing but a 403 indistinguishable from the
			// registration gate. Says nothing about the allowlist.
			return Response.json(
				{ message: "Request origin is not trusted", code: "INVALID_ORIGIN" },
				{ status: 403 },
			);
		}
	}

	const unavailable = mailUnavailableResponse(request);
	if (unavailable) return unavailable;

	if (
		request.method === "GET" &&
		new URL(request.url).pathname === "/api/auth/token"
	) {
		const response = await auth.handler(request);
		if (response.status !== 401) return response;
		// Better Auth's session middleware turns lookup faults into 401. Only
		// an authoritative missing session may stop automatic Zero token refresh.
		try {
			const session = await auth.api.getSession({
				headers: request.headers,
				query: { disableCookieCache: true },
			});
			if (!session) return response;
		} catch (error) {
			console.error("Zero token session lookup unavailable", error);
		}
		return Response.json(
			{
				code: "SESSION_UNAVAILABLE",
				message: "Session verification unavailable",
			},
			{
				status: 503,
				headers: { "cache-control": "no-store", "retry-after": "5" },
			},
		);
	}

	if (registrationMode !== "bootstrap" || (await registeredUserCount()) > 0) {
		return auth.handler(request);
	}

	const client = await pool.connect();
	try {
		await client.query("select pg_advisory_lock($1)", [REGISTRATION_LOCK_KEY]);
		return await auth.handler(request);
	} finally {
		await client.query("select pg_advisory_unlock($1)", [
			REGISTRATION_LOCK_KEY,
		]);
		client.release();
	}
}
