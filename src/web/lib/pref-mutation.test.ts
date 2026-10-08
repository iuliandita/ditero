import { describe, expect, test } from "vitest";
import { createExportBoundary } from "./export-boundary.ts";
import { changeLocale } from "./language-switcher.ts";
import { mutationServerSucceeded } from "./pref-mutation.ts";
import { registerZeroClient } from "./zero-lifecycle.ts";

const success = { type: "success" };
function deferred() {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function journal(): Storage {
	const entries = new Map<string, string>();
	return {
		get length() {
			return entries.size;
		},
		clear: () => entries.clear(),
		getItem: (key) => entries.get(key) ?? null,
		key: (index) => [...entries.keys()][index] ?? null,
		removeItem: (key) => {
			entries.delete(key);
		},
		setItem: (key, value) => {
			entries.set(key, value);
		},
	};
}
function boundary(storage: Storage, generation: string) {
	return createExportBoundary({
		userID: "user",
		clientID: "client",
		generation,
		storage,
		isConnected: () => true,
	});
}

describe("mutationServerSucceeded", () => {
	test("does not report success before both local and server results arrive", async () => {
		const client = deferred();
		const server = deferred();
		let settled = false;
		const result = mutationServerSucceeded({
			client: client.promise,
			server: server.promise,
		}).then((value) => {
			settled = true;
			return value;
		});
		server.resolve(success);
		await nextTurn();
		expect(settled).toBe(false);
		client.resolve(success);
		await expect(result).resolves.toBe(true);
	});

	test.each([
		"client",
		"server",
	] as const)("observes %s rejection while the other result is pending", async (side) => {
		const client = deferred();
		const server = deferred();
		const result = mutationServerSucceeded({
			client: client.promise,
			server: server.promise,
		});
		({ client, server })[side].reject(new Error("unavailable"));
		await expect(result).resolves.toBe(false);
		({ client, server })[side === "client" ? "server" : "client"].reject(
			new Error("late rejection"),
		);
		await nextTurn();
	});

	test.each([
		undefined,
		{ type: "success", unexpected: true },
		{ type: "error", error: { type: "app", message: "refused" } },
		{ type: "error", error: { type: "zero", message: "offline" } },
	])("rejects unproven local or server success %j", async (value) => {
		await expect(
			mutationServerSucceeded({
				client: Promise.resolve(value),
				server: Promise.resolve(success),
			}),
		).resolves.toBe(false);
		await expect(
			mutationServerSucceeded({
				client: Promise.resolve(success),
				server: Promise.resolve(value),
			}),
		).resolves.toBe(false);
	});

	test.each([
		"server-first",
		"client-first",
	])("locale retirement leaves no prior journal after %s success", async (order) => {
		const storage = journal();
		const tracker = boundary(storage, "first");
		const client = deferred();
		const server = deferred();
		const zero = {
			userID: "user",
			mutate: () => ({ client: client.promise, server: server.promise }),
			close: async () => {},
		};
		const owner = registerZeroClient("user", zero, () => tracker.dispose());
		const tracked = zero.mutate;
		Object.defineProperty(zero, "mutate", {
			value: () => tracker.wrapMutation(tracked),
		});
		let applied = false;
		try {
			const changed = changeLocale("en", {
				persistLocale: () => mutationServerSucceeded(zero.mutate()),
				retireClients: owner.retire,
				applyDocumentLocale: () => {
					applied = true;
				},
				setLocale: () => {},
			});
			expect(storage.length).toBe(1);
			if (order === "server-first") {
				server.resolve(success);
				client.resolve(success);
			} else {
				client.resolve(success);
				await nextTurn();
				server.resolve(success);
			}
			await expect(changed).resolves.toBe(true);
			expect(applied).toBe(true);
			expect(storage.length).toBe(0);
			expect(boundary(storage, "next").getSnapshot().prior).toBe(false);
		} finally {
			client.resolve(success);
			server.resolve(success);
			await owner.retire();
		}
	});

	test.each([
		"unknown",
		"refused",
		"prior",
	])("preserves the %s export guard", async (kind) => {
		const storage = journal();
		if (kind === "prior") {
			boundary(storage, "previous").wrapMutation(() => ({
				client: Promise.resolve(success),
				server: deferred().promise,
			}));
		}
		const tracker = boundary(storage, "current");
		const mutation = tracker.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(
				kind === "unknown"
					? undefined
					: kind === "refused"
						? { type: "error", error: { type: "app", message: "refused" } }
						: success,
			),
		}));
		await expect(mutationServerSucceeded(mutation)).resolves.toBe(
			kind === "prior",
		);
		await nextTurn();
		expect(tracker.getSnapshot()).toMatchObject({
			pending: 0,
			uncertain: kind === "unknown",
			refused: kind === "refused",
			prior: kind === "prior",
		});
		expect(storage.length).toBe(1);
		tracker.dispose();
	});
});
