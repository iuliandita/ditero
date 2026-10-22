import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth";
import type { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema.ts";

type AdapterFactory = ReturnType<typeof drizzleAdapter>;
type Database = Pick<NodePgDatabase<typeof schema>, "transaction" | "execute">;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const RESET_PATH = "/api/auth/reset-password";
export const RESET_CALLBACK_PATH = "/reset-password";

export type ResetRevocation = {
	accessTokens: number;
	calendarFeeds: number;
	passkeys: number;
	linkedAccounts: number;
};

type ResetState = { revoked?: ResetRevocation };
const passwordReset = new AsyncLocalStorage<ResetState>();

// Better Auth builds the mailed link from whatever redirectTo the requesting
// client sent. Pin it to the web page: a native client's redirect target does
// not open in the browser the mail is read in.
export function resetLinkWithWebCallback(rawUrl: string): string {
	const url = new URL(rawUrl);
	url.searchParams.set("callbackURL", RESET_CALLBACK_PATH);
	return url.href;
}

// Someone holding the old password could have planted any of these; the reset
// is the owner's only way to take them back. Workspace-level secrets
// (inbound webhooks, channel credentials) and two-factor enrollment stay.
export async function revokeResetCredentials(
	tx: Pick<Transaction, "execute">,
	userId: string,
): Promise<ResetRevocation> {
	// Token and feed rows are row-level secured by the acting user. Creating
	// either locks the user row too, so one that commits first is revoked here.
	await tx.execute(sql`select set_config('ditero.user_id', ${userId}, true)`);
	await tx.execute(sql`select id from "user" where id = ${userId} for update`);
	// Any other outstanding reset link could reset the password again.
	await tx.execute(
		sql`delete from verification where identifier like 'reset-password:%' and value = ${userId}`,
	);
	const accessTokens = await tx.execute(
		sql`update personal_access_token set revoked_at = statement_timestamp() where user_id = ${userId} and revoked_at is null`,
	);
	const calendarFeeds = await tx.execute(
		sql`update calendar_feed set revoked_at = statement_timestamp() where user_id = ${userId} and revoked_at is null`,
	);
	const passkeys = await tx.execute(
		sql`delete from passkey where user_id = ${userId}`,
	);
	const linkedAccounts = await tx.execute(
		sql`delete from account where user_id = ${userId} and provider_id <> 'credential'`,
	);
	return {
		accessTokens: accessTokens.rowCount ?? 0,
		calendarFeeds: calendarFeeds.rowCount ?? 0,
		passkeys: passkeys.rowCount ?? 0,
		linkedAccounts: linkedAccounts.rowCount ?? 0,
	};
}

type AdapterCall = {
	model: string;
	where?: { field: string; value: unknown }[];
	update?: Record<string, unknown>;
	data?: Record<string, unknown>;
};

function credentialOwner(property: PropertyKey, input: AdapterCall) {
	if (input.model !== "account") return undefined;
	if (property === "create")
		return input.data?.providerId === "credential" && input.data.password
			? input.data.userId
			: undefined;
	if ((property === "update" || property === "updateMany") && input.update)
		return "password" in input.update
			? input.where?.find((clause) => clause.field === "userId")?.value
			: undefined;
	return undefined;
}

function observePasswordWrite<T extends object>(
	adapter: T,
	onWrite: (userId: string) => void,
): T {
	return new Proxy(adapter, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (typeof value !== "function") return value;
			if (!["create", "update", "updateMany"].includes(String(property)))
				return value.bind(target);
			return async (input: AdapterCall) => {
				const result = await Reflect.apply(value, target, [input]);
				const userId = credentialOwner(property, input);
				if (typeof userId === "string") {
					if (property === "updateMany" ? result !== 1 : !result)
						throw resetUnavailable();
					onWrite(userId);
				}
				return result;
			};
		},
	});
}

// The drizzle adapter has no transactions of its own, so Better Auth's reset
// (spend token, end sessions, write password) would otherwise commit step by
// step. Inside a reset request, give it a real one and revoke the planted
// credentials in it: either all of it lands or none of it does.
export function withPasswordResetTransaction(
	build: (database: Database | Transaction) => AdapterFactory,
	database: Database,
): AdapterFactory {
	const base = build(database);
	return (options) => {
		const adapter = base(options);
		return new Proxy(adapter, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (typeof value !== "function") return value;
				if (property !== "transaction") return value.bind(target);
				return async (callback: (transaction: object) => Promise<unknown>) => {
					const state = passwordReset.getStore();
					if (!state) return Reflect.apply(value, target, [callback]);
					return database.transaction(async (tx) => {
						let userId: string | undefined;
						const result = await callback(
							observePasswordWrite(build(tx)(options), (id) => {
								userId = id;
							}),
						);
						// Roll back rather than commit a password change that nothing revoked.
						if (userId === undefined) throw resetUnavailable();
						state.revoked = await revokeResetCredentials(tx, userId);
						return result;
					});
				};
			},
		});
	};
}

// A reset that does not pass through runPasswordReset would change the
// password and leave every planted credential working.
export function assertPasswordResetScope(): void {
	if (!passwordReset.getStore()) throw resetUnavailable();
}

function resetUnavailable(): APIError {
	return new APIError("INTERNAL_SERVER_ERROR", {
		code: "RESET_UNAVAILABLE",
		message: "Password reset is unavailable",
	});
}

export async function runPasswordReset(
	handle: () => Promise<Response>,
): Promise<Response> {
	const state: ResetState = {};
	const response = await passwordReset.run(state, handle);
	if (!response.ok) return response;
	if (!state.revoked) {
		console.error("password reset finished without revoking credentials");
		return Response.json(
			{ code: "RESET_UNAVAILABLE", message: "Password reset is unavailable" },
			{ status: 500 },
		);
	}
	return Response.json(
		{ status: true, revoked: state.revoked },
		{ headers: { "cache-control": "no-store" } },
	);
}
