import { afterEach, describe, expect, test, vi } from "vitest";
import {
	assertPasswordResetScope,
	resetLinkWithWebCallback,
	runPasswordReset,
	withPasswordResetTransaction,
} from "./password-reset.ts";

afterEach(() => vi.restoreAllMocks());

test("the mailed link always lands on the web reset page", () => {
	expect(
		resetLinkWithWebCallback(
			"https://todo.example/api/auth/reset-password/tok?callbackURL=capacitor%3A%2F%2Flocalhost%2Fx",
		),
	).toBe(
		"https://todo.example/api/auth/reset-password/tok?callbackURL=%2Freset-password",
	);
	expect(
		resetLinkWithWebCallback(
			"https://todo.example/api/auth/reset-password/tok?callbackURL=",
		),
	).toBe(
		"https://todo.example/api/auth/reset-password/tok?callbackURL=%2Freset-password",
	);
});

type Call = { model: string; [key: string]: unknown };

function fakeDatabase() {
	const statements: string[] = [];
	const tx = {
		execute: vi.fn(async (query: { queryChunks: unknown[] }) => {
			statements.push(
				query.queryChunks
					.map((chunk) =>
						typeof chunk === "object" && chunk && "value" in chunk
							? (chunk.value as string[]).join("")
							: "?",
					)
					.join(""),
			);
			return { rowCount: 1 };
		}),
	};
	const database = {
		transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) =>
			run(tx),
		),
		execute: vi.fn(),
	};
	return { database, statements };
}

function fakeFactory() {
	const calls: Call[] = [];
	const plain = vi.fn(async (callback: (a: object) => Promise<unknown>) =>
		callback(adapter),
	);
	const adapter = {
		transaction: plain,
		create: vi.fn(async (input: Call) => {
			calls.push(input);
			return input;
		}),
		updateMany: vi.fn(async (input: Call) => {
			calls.push(input);
			return 1;
		}),
		update: vi.fn(async (input: Call) => {
			calls.push(input);
			return input;
		}),
	};
	return { factory: () => adapter, adapter, calls, plain };
}

describe("withPasswordResetTransaction", () => {
	test("outside a reset the adapter keeps its own transaction", async () => {
		const { database } = fakeDatabase();
		const { factory, plain } = fakeFactory();
		const wrapped = withPasswordResetTransaction(
			() => factory as never,
			database as never,
		)({} as never) as unknown as { transaction: typeof plain };
		await wrapped.transaction(async () => "done");
		expect(plain).toHaveBeenCalledOnce();
		expect(database.transaction).not.toHaveBeenCalled();
	});

	test.each([
		[
			"an updated credential password",
			(adapter: Record<string, (input: Call) => Promise<unknown>>) =>
				adapter.updateMany({
					model: "account",
					where: [
						{ field: "userId", value: "user-1" },
						{ field: "providerId", value: "credential" },
					],
					update: { password: "hash" },
				}),
		],
		[
			"a first credential account",
			(adapter: Record<string, (input: Call) => Promise<unknown>>) =>
				adapter.create({
					model: "account",
					data: {
						userId: "user-1",
						providerId: "credential",
						password: "hash",
					},
				}),
		],
	])("revokes in the reset's own transaction after %s", async (_label, write) => {
		const { database, statements } = fakeDatabase();
		const { factory } = fakeFactory();
		const wrapped = withPasswordResetTransaction(
			() => factory as never,
			database as never,
		)({} as never) as unknown as {
			transaction: (
				callback: (adapter: object) => Promise<unknown>,
			) => Promise<unknown>;
		};
		const response = await runPasswordReset(async () => {
			await wrapped.transaction((adapter) =>
				write(adapter as Record<string, (input: Call) => Promise<unknown>>),
			);
			return Response.json({ status: true });
		});
		expect(database.transaction).toHaveBeenCalledOnce();
		expect(statements).toEqual([
			"select set_config('ditero.user_id', ?, true)",
			'select id from "user" where id = ? for update',
			"delete from verification where identifier like 'reset-password:%' and value = ?",
			"update personal_access_token set revoked_at = statement_timestamp() where user_id = ? and revoked_at is null",
			"update calendar_feed set revoked_at = statement_timestamp() where user_id = ? and revoked_at is null",
			"delete from passkey where user_id = ?",
			"delete from account where user_id = ? and provider_id <> 'credential'",
		]);
		expect(await response.json()).toEqual({
			status: true,
			revoked: {
				accessTokens: 1,
				calendarFeeds: 1,
				passkeys: 1,
				linkedAccounts: 1,
			},
		});
	});
});

test("a reset transaction without a credential write rolls back", async () => {
	const { database, statements } = fakeDatabase();
	const { factory } = fakeFactory();
	const wrapped = withPasswordResetTransaction(
		() => factory as never,
		database as never,
	)({} as never) as unknown as {
		transaction: (callback: () => Promise<unknown>) => Promise<unknown>;
	};
	vi.spyOn(console, "error").mockImplementation(() => {});
	const response = await runPasswordReset(async () => {
		await expect(wrapped.transaction(async () => "done")).rejects.toThrow(
			"Password reset is unavailable",
		);
		return Response.json({ status: true });
	});
	expect(statements).toEqual([]);
	expect(response.status).toBe(500);
});

describe("runPasswordReset", () => {
	test("passes refusals through untouched", async () => {
		const refused = Response.json({ code: "INVALID_TOKEN" }, { status: 400 });
		expect(await runPasswordReset(async () => refused)).toBe(refused);
	});

	test("refuses to report success when nothing was revoked", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await runPasswordReset(async () =>
			Response.json({ status: true }),
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: "RESET_UNAVAILABLE" });
		expect(error).toHaveBeenCalled();
	});

	test("is the only scope in which a reset may run", async () => {
		expect(() => assertPasswordResetScope()).toThrow();
		await runPasswordReset(async () => {
			expect(() => assertPasswordResetScope()).not.toThrow();
			return new Response(null, { status: 400 });
		});
	});
});
