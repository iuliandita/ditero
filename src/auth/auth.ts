import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { count } from "drizzle-orm";
import { db, pool } from "../db/client.ts";
import { user } from "../db/schema.ts";
import { ensurePersonalWorkspace } from "./bootstrap.ts";
import { trustedAuthOrigins } from "./origins.ts";
import { socialProvidersFromEnv } from "./providers.ts";
import {
	assertRegistrationAllowed,
	resolveRegistrationMode,
} from "./registration.ts";

const REGISTRATION_LOCK_KEY = 6_794_321;
const registrationMode = resolveRegistrationMode(process.env);

async function registeredUserCount(): Promise<number> {
	const [result] = await db.select({ value: count() }).from(user);
	return result.value;
}

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.BETTER_AUTH_URL,
	trustedOrigins: trustedAuthOrigins(process.env),
	emailAndPassword: { enabled: true },
	socialProviders: socialProvidersFromEnv({
		GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
		GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
	}),
	databaseHooks: {
		user: {
			create: {
				before: async () => {
					try {
						assertRegistrationAllowed(
							registrationMode,
							await registeredUserCount(),
						);
					} catch (error) {
						throw new APIError("FORBIDDEN", {
							message:
								error instanceof Error ? error.message : "Registration denied",
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
	plugins: [jwt()],
});

export async function handleAuthRequest(request: Request): Promise<Response> {
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
