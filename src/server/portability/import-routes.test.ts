import { Elysia } from "elysia";
import type { Pool } from "pg";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PortableExportV1 } from "../../domain/portability/v1.ts";
import { makeGuards, type Session } from "../guards.ts";
import { V4ApplyConflict } from "./import-activation.ts";

const store = vi.hoisted(() => ({
	save: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	discardPlan: vi.fn(),
	discardSource: vi.fn(),
	apply: vi.fn(),
	run: vi.fn(),
}));
vi.mock("./import-apply-store.ts", () => ({
	applyImportBatch: store.apply,
	getImportRunStatus: store.run,
}));
vi.mock("./import-plan-store.ts", () => ({
	saveImportPlan: store.save,
	listImportSources: store.list,
	getImportPlanStatus: store.get,
	discardImportPlan: store.discardPlan,
	discardImportSource: store.discardSource,
	ImportPlanStoreError: class extends Error {},
}));

import { importPlanRoutes } from "./import-routes.ts";

function document(): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: "2026-09-16T00:00:00.000Z",
		sourceUserId: "source-user",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			principals: [{ id: "source-user", name: "Source user" }],
			workspaces: [],
			memberships: [],
			folders: [],
			lists: [],
			tasks: [],
			labels: [],
			taskLabels: [],
			templates: [],
			assignments: [],
			comments: [],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
		},
	};
}
function payload() {
	return {
		source: {
			mode: "new",
			id: "11111111-1111-4111-8111-111111111111",
			label: "Old server",
		},
		document: JSON.stringify(document()),
		mappings: { workspaces: {}, principals: { "source-user": "caller" } },
	};
}
function app() {
	const guards = makeGuards(["http://localhost"], async (headers) =>
		headers.get("x-user")
			? ({ user: { id: headers.get("x-user") } } as Session)
			: null,
	);
	return new Elysia().use(importPlanRoutes({} as Pool, guards));
}
function request(
	body: BodyInit = JSON.stringify(payload()),
	extra: Record<string, string> = {},
) {
	const init: RequestInit & { duplex: "half" } = {
		duplex: "half",
		method: "POST",
		headers: {
			origin: "http://localhost",
			"x-user": "caller",
			"content-type": "application/json",
			...extra,
		},
		body,
	};
	return new Request("http://localhost/api/portability/import/plans", init);
}

beforeEach(() => {
	vi.clearAllMocks();
	store.save.mockResolvedValue({
		id: "saved",
		report: { plannerVersion: 4, applySupported: true },
	});
	store.list.mockResolvedValue([]);
	store.get.mockResolvedValue(null);
	store.discardPlan.mockResolvedValue(false);
	store.discardSource.mockResolvedValue(false);
	store.apply.mockResolvedValue({ state: "completed" });
	store.run.mockResolvedValue(null);
});

describe("native import plan transport", () => {
	test("authenticates and checks origin before reading or saving", async () => {
		const api = app();
		expect((await api.handle(request("{", { "x-user": "" }))).status).toBe(401);
		expect(
			(await api.handle(request("{", { origin: "https://foreign.test" })))
				.status,
		).toBe(403);
		expect(store.save).not.toHaveBeenCalled();
	});
	test("validates the native document and returns a private saved report", async () => {
		const result = await app().handle(request());
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(store.save).toHaveBeenCalledWith(
			expect.anything(),
			"caller",
			payload().source,
			document(),
			payload().mappings,
			{
				signal: expect.any(AbortSignal),
				deadline: expect.any(Number),
				plannerVersion: 4,
			},
		);
		expect(await result.json()).toMatchObject({
			report: { plannerVersion: 4, applySupported: true },
		});
	});
	test("refuses malformed, unknown-field and invalid native requests before storage", async () => {
		for (const body of [
			"{",
			JSON.stringify({ ...payload(), extra: true }),
			JSON.stringify({ ...payload(), document: "{}" }),
			JSON.stringify({
				...payload(),
				source: { mode: "existing", id: "other" },
			}),
			JSON.stringify({
				...payload(),
				mappings: {
					workspaces: {},
					principals: { "source-user": { id: "caller" } },
				},
			}),
		]) {
			expect((await app().handle(request(body))).status).toBe(400);
		}
		expect(store.save).not.toHaveBeenCalled();
	});
	test("refuses oversized declarations and streaming bodies independently", async () => {
		expect(
			(
				await app().handle(
					request("{}", { "content-length": String(67 * 1024 * 1024) }),
				)
			).status,
		).toBe(413);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(67 * 1024 * 1024));
				controller.close();
			},
		});
		expect((await app().handle(request(body))).status).toBe(413);
		expect(store.save).not.toHaveBeenCalled();
	});
	test("handles split UTF-8 without corrupting source labels", async () => {
		const value = payload();
		value.source.label = "Ancien café";
		const raw = new TextEncoder().encode(JSON.stringify(value));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of raw) controller.enqueue(Uint8Array.of(byte));
				controller.close();
			},
		});
		expect((await app().handle(request(body))).status).toBe(200);
		expect(store.save.mock.calls[0]?.[2].label).toBe("Ancien café");
	});
	test("treats prototype-looking source IDs as data", async () => {
		const value = payload();
		const doc = document();
		doc.sourceUserId = "__proto__";
		doc.data.principals[0].id = "__proto__";
		value.document = JSON.stringify(doc);
		value.mappings.principals = JSON.parse('{"__proto__":"caller"}');
		expect((await app().handle(request(JSON.stringify(value)))).status).toBe(
			200,
		);
		expect(
			Object.hasOwn(store.save.mock.calls[0]?.[4].principals, "__proto__"),
		).toBe(true);
	});
	test("holds admission until a save actually stops, then accepts retry", async () => {
		let finish: ((value: unknown) => void) | undefined;
		store.save.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const api = app();
		const first = api.handle(request());
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
		const second = await api.handle(request());
		expect(second.status).toBe(429);
		expect(second.headers.get("retry-after")).toBe("5");
		finish?.({ id: "saved" });
		expect((await first).status).toBe(200);
		expect((await api.handle(request())).status).toBe(200);
	});
	test("admits another account while keeping the global cap bounded", async () => {
		const finish: ((value: unknown) => void)[] = [];
		store.save.mockImplementation(
			() => new Promise((resolve) => finish.push(resolve)),
		);
		const api = app();
		const first = api.handle(request());
		const second = api.handle(
			request(JSON.stringify(payload()), { "x-user": "second" }),
		);
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
		expect(
			(
				await api.handle(
					request(JSON.stringify(payload()), { "x-user": "third" }),
				)
			).status,
		).toBe(429);
		for (const resolve of finish) resolve({ id: "saved" });
		expect((await first).status).toBe(200);
		expect((await second).status).toBe(200);
	});
	test("cancels a stalled upload and releases admission", async () => {
		const api = app();
		const controller = new AbortController();
		const pending = api.handle(
			new Request(request(new ReadableStream()), { signal: controller.signal }),
		);
		controller.abort();
		expect((await pending).status).toBe(408);
		expect((await api.handle(request())).status).toBe(200);
	});
	test("returns private not-found for unknown plans and discards", async () => {
		const api = app();
		for (const [path, method] of [
			["plans/unknown", "GET"],
			["plans/unknown/discard", "POST"],
			["sources/unknown/discard", "POST"],
		]) {
			const result = await api.handle(
				new Request(`http://localhost/api/portability/import/${path}`, {
					method,
					headers: { "x-user": "caller", origin: "http://localhost" },
				}),
			);
			expect(result.status).toBe(404);
		}
	});
});

const confirmation = {
	planDigest: "a".repeat(64),
	counts: { ensure: 4, ignored: 2, blocked: 1 },
};
function applyRequest(
	body: BodyInit = JSON.stringify(confirmation),
	extra: Record<string, string> = {},
) {
	return new Request(
		"http://localhost/api/portability/import/plans/saved/apply",
		{
			method: "POST",
			headers: {
				origin: "http://localhost",
				"x-user": "caller",
				"content-type": "application/json",
				...extra,
			},
			body,
		},
	);
}

describe("native import execution transport", () => {
	test("returns a private conflict response for activation preflight limits", async () => {
		store.apply.mockRejectedValueOnce(
			new V4ApplyConflict("activation-readiness-limit", 100),
		);
		const result = await app().handle(applyRequest());
		expect(result.status).toBe(409);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(await result.json()).toEqual({ code: "activation-readiness-limit" });
	});
	test("authenticates and checks origin before execution", async () => {
		const api = app();
		expect((await api.handle(applyRequest("{", { "x-user": "" }))).status).toBe(
			401,
		);
		expect(
			(await api.handle(applyRequest("{", { origin: "https://foreign.test" })))
				.status,
		).toBe(403);
		expect(store.apply).not.toHaveBeenCalled();
	});
	test("passes exact confirmation and caller identity under a private response", async () => {
		const result = await app().handle(applyRequest());
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(store.apply).toHaveBeenCalledWith(
			expect.anything(),
			"caller",
			"saved",
			confirmation,
			{ signal: expect.any(AbortSignal), deadline: expect.any(Number) },
		);
	});
	test("rejects malformed, oversized and extra confirmation fields before execution", async () => {
		for (const body of [
			"{",
			"{}",
			JSON.stringify({ ...confirmation, extra: true }),
			JSON.stringify({
				...confirmation,
				counts: { ...confirmation.counts, ensure: -1 },
			}),
		])
			expect((await app().handle(applyRequest(body))).status).toBe(400);
		expect((await app().handle(applyRequest(" ".repeat(4097)))).status).toBe(
			413,
		);
		expect(
			(await app().handle(applyRequest("{}", { "content-length": "4097" })))
				.status,
		).toBe(413);
		expect(store.apply).not.toHaveBeenCalled();
	});
	test("shares request admission with planning until the batch settles", async () => {
		let finish: ((value: unknown) => void) | undefined;
		store.apply.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const api = app();
		const first = api.handle(applyRequest());
		await vi.waitFor(() => expect(store.apply).toHaveBeenCalledTimes(1));
		expect((await api.handle(applyRequest())).status).toBe(429);
		expect((await api.handle(request())).status).toBe(429);
		finish?.({ state: "running" });
		expect((await first).status).toBe(200);
		expect((await api.handle(applyRequest())).status).toBe(200);
	});
	test("reads owner-scoped run status without caching", async () => {
		const result = await app().handle(
			new Request("http://localhost/api/portability/import/plans/saved/run", {
				headers: { "x-user": "caller" },
			}),
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(await result.json()).toEqual({ run: null });
		expect(store.run).toHaveBeenCalledWith(
			expect.anything(),
			"caller",
			"saved",
		);
	});
});
