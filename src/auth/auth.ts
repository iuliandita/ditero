import { passkey } from "@better-auth/passkey";
import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, twoFactor } from "better-auth/plugins";
import { count, isNull } from "drizzle-orm";
import { db, pool } from "../db/client.ts";
import { user } from "../db/schema.ts";
import { createFieldKeyRing } from "../security/field-encryption.ts";
import {
	sanitizeAuthRequest,
	trustedProxyCIDRsFromEnv,
} from "../server/client-ip.ts";
import { ensurePersonalWorkspace } from "./bootstrap.ts";
import { withFieldEncryption } from "./encrypted-adapter.ts";
import { emailHasRedeemableInvite } from "./invite-bypass.ts";
import { mailUnavailableResponse, sendAuthMail } from "./mail.ts";
import { trustedAuthOrigins } from "./origins.ts";
import { socialProvidersFromEnv } from "./providers.ts";
import {
	assertRegistrationAllowed,
	RegistrationDeniedError,
	resolveRegistrationMode,
} from "./registration.ts";
import { registrationBypassActive } from "./registration-bypass.ts";
import {
	authRateLimitOptions,
	passkeyOptions,
	requireSameOrigin,
} from "./security.ts";

const REGISTRATION_LOCK_KEY = 6_794_321;
const registrationMode = resolveRegistrationMode(process.env);
const authOrigins = [
	process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
	...trustedAuthOrigins(process.env),
];
const trustedProxies = trustedProxyCIDRsFromEnv(
	process.env.DITERO_TRUSTED_PROXIES,
);
const encryptionKey = process.env.DITERO_ENCRYPTION_KEY;
if (process.env.NODE_ENV === "production" && !encryptionKey) {
	throw new Error("DITERO_ENCRYPTION_KEY is required in production");
}
const authAdapter = drizzleAdapter(db, { provider: "pg" });
const authDatabase = encryptionKey
	? withFieldEncryption(
			authAdapter,
			createFieldKeyRing({
				current: encryptionKey,
				next: process.env.DITERO_ENCRYPTION_KEY_NEXT,
			}),
		)
	: authAdapter;

async function registeredUserCount(): Promise<number> {
	const [result] = await db
		.select({ value: count() })
		.from(user)
		.where(isNull(user.deletedAt));
	return result.value;
}

export const auth = betterAuth({
	appName: "Ditero",
	database: authDatabase,
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	trustedOrigins: trustedAuthOrigins(process.env),
	emailAndPassword: {
		enabled: true,
		sendResetPassword: async ({ user, url }) => {
			sendAuthMail("reset", user, url);
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
	socialProviders: socialProvidersFromEnv({
		GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
		GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
	}),
	databaseHooks: {
		user: {
			create: {
				before: async (newUser) => {
					try {
						const invited =
							registrationBypassActive() ||
							(await emailHasRedeemableInvite(newUser.email, db, Date.now()));
						assertRegistrationAllowed(
							registrationMode,
							await registeredUserCount(),
							{ invited },
						);
					} catch (error) {
						throw new APIError("FORBIDDEN", {
							message:
								error instanceof Error ? error.message : "Registration denied",
							// Only the deliberate refusals carry a code; anything else
							// reaching here (a failed invite lookup, say) is a fault, and
							// labelling it as policy would mislead the client.
							code:
								error instanceof RegistrationDeniedError
									? error.code
									: undefined,
						});
					}
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
	// jwt plugin exposes /api/auth/token and JWKS at /api/auth/jwks.
	plugins: [
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
		jwt(),
	],
});

export async function handleAuthRequest(
	request: Request,
	peerAddress?: string,
): Promise<Response> {
	request = sanitizeAuthRequest(request, peerAddress, trustedProxies);
	if (
		request.method !== "GET" &&
		(request.headers.has("origin") || request.headers.has("cookie"))
	) {
		try {
			requireSameOrigin(request, authOrigins);
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
