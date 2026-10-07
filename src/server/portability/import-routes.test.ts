import { readFileSync } from "node:fs";
import { Elysia } from "elysia";
import type { Pool } from "pg";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CSV_V1_EXCLUSIONS } from "../../domain/portability/providers/input.ts";
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
	parents: vi.fn(),
}));
vi.mock("./attachment-migration-parents.ts", () => ({
	getAttachmentMigrationParents: store.parents,
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
	ImportPlanStoreError: class extends Error {
		constructor(
			readonly code: string,
			readonly status: number,
		) {
			super("Import request could not be completed");
		}
	},
}));

import { ImportPlanStoreError } from "./import-plan-store.ts";
import { createImportAdmission, importPlanRoutes } from "./import-routes.ts";

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
	store.parents.mockResolvedValue({ items: [], nextAfterOrdinal: null });
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
	test("qualifies validated history archives without accepting client authority flags", async () => {
		const source = document();
		const archive = {
			...source,
			schemaVersion: 2,
			sourceNamespace: "11111111-1111-4111-8111-111111111111",
			boundaries: { ...source.boundaries, taskHistory: "recorded-events-only" },
			data: { ...source.data, completionEvents: [] },
		};
		store.save.mockResolvedValueOnce({
			id: "saved-v5",
			report: {
				plannerVersion: 5,
				applySupported: true,
			},
		});
		const result = await app().handle(
			request(
				JSON.stringify({ ...payload(), document: JSON.stringify(archive) }),
			),
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(await result.json()).toMatchObject({
			report: {
				plannerVersion: 5,
				applySupported: true,
			},
		});
		expect(store.save).toHaveBeenCalledWith(
			expect.anything(),
			"caller",
			expect.anything(),
			archive,
			expect.anything(),
			expect.objectContaining({ plannerVersion: 4, historyApply: true }),
		);
		store.save.mockClear();
		expect(
			(
				await app().handle(
					request(JSON.stringify({ ...payload(), historyApply: true })),
				)
			).status,
		).toBe(400);
		expect(store.save).not.toHaveBeenCalled();
		const malformed = await app().handle(
			request(JSON.stringify({ ...payload(), document: '{"schemaVersion":2' })),
		);
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).not.toEqual({
			code: "unsupported-import-version",
		});
		expect(store.save).not.toHaveBeenCalled();
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
	test("accepts an empty source mapping key but rejects an empty target", async () => {
		const value = {
			...payload(),
			mappings: {
				workspaces: {},
				principals: { "": "caller" } as Record<string, string>,
			},
		};
		const doc = document();
		doc.sourceUserId = "";
		doc.data.principals[0].id = "";
		value.document = JSON.stringify(doc);
		expect((await app().handle(request(JSON.stringify(value)))).status).toBe(
			200,
		);
		expect(store.save.mock.calls[0]?.[4].principals).toEqual({ "": "caller" });
		value.mappings.principals = { "": "" };
		expect((await app().handle(request(JSON.stringify(value)))).status).toBe(
			400,
		);
		expect(store.save).toHaveBeenCalledTimes(1);
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

function csvPayload() {
	const { document: _document, ...base } = payload();
	return {
		...base,
		input: {
			kind: "provider",
			version: 1,
			adapter: "ditero-csv",
			adapterVersion: 1,
			sourceNamespace: "fcb28f31-12ae-4c9d-82f2-1289d9fcb411",
			identityMode: "stable-ids",
			exclusions: [...CSV_V1_EXCLUSIONS],
			originalCsvBase64: readFileSync(
				new URL(
					"../../../tests/fixtures/portability/providers/csv-v1.csv",
					import.meta.url,
				),
			).toString("base64"),
		},
	};
}
test("reparses original CSV and passes only validated binding and ordinary content to storage", async () => {
	const value = csvPayload();
	const result = await app().handle(request(JSON.stringify(value)));
	expect(result.status).toBe(200);
	expect(
		store.save.mock.calls[0]?.[3].data.tasks.map(
			(row: { title: string }) => row.title,
		),
	).toEqual(["Prepare groceries", "Buy apples"]);
	expect(store.save.mock.calls[0]?.[5]).toMatchObject({
		plannerVersion: 4,
		inputBinding: {
			adapter: "ditero-csv",
			identityMode: "stable-ids",
			exclusions: CSV_V1_EXCLUSIONS,
		},
	});
	expect(store.save.mock.calls[0]?.[5]).not.toHaveProperty("historyApply");
	expect(store.save.mock.calls[0]?.[5].inputBinding).not.toHaveProperty(
		"originalCsvBase64",
	);
});
test.each([
	"native-mix",
	"policy",
	"namespace",
	"encoding",
	"extra",
])("refuses CSV %s before persistence", async (change) => {
	const value = csvPayload();
	const body: Record<string, unknown> = value;
	if (change === "native-mix") body.document = JSON.stringify(document());
	if (change === "policy") value.input.exclusions.reverse();
	if (change === "namespace")
		value.input.sourceNamespace = "11111111-1111-4111-8111-111111111111";
	if (change === "encoding")
		value.input.originalCsvBase64 = Buffer.from([255]).toString("base64");
	if (change === "extra") body.convertedDocument = document();
	expect((await app().handle(request(JSON.stringify(body)))).status).toBe(400);
	expect(store.save).not.toHaveBeenCalled();
});

function paddedRequestBody(value: unknown, bytes: number): string {
	const json = JSON.stringify(value);
	return `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
}
function chunkedBody(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset === bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.subarray(offset, offset + 65_536));
			offset = Math.min(offset + 65_536, bytes.length);
		},
	});
}
test.each([
	"padded",
	"chunked",
])("provider cap counts actual %s upload bytes before conversion", async (kind) => {
	const value = csvPayload();
	value.source.label = "Café source";
	const text = paddedRequestBody(value, 32 * 1024 * 1024 + 1);
	expect(Buffer.byteLength(text)).toBe(32 * 1024 * 1024 + 1);
	const response = await app().handle(
		request(kind === "chunked" ? chunkedBody(text) : text),
	);
	expect(response.status).toBe(413);
	expect(await response.json()).toEqual({ code: "request-limit" });
	expect(store.save).not.toHaveBeenCalled();
});
test("provider exact cap and native upload above provider cap retain their positive limits", async () => {
	const provider = paddedRequestBody(csvPayload(), 32 * 1024 * 1024);
	expect((await app().handle(request(chunkedBody(provider)))).status).toBe(200);
	const native = paddedRequestBody(payload(), 33 * 1024 * 1024);
	expect((await app().handle(request(native))).status).toBe(200);
	expect(store.save).toHaveBeenCalledTimes(2);
});

describe("attachment parent discovery transport", () => {
	const jobId = "a".repeat(64);
	function parentRequest(query = "", user = "caller", signal?: AbortSignal) {
		return new Request(
			`http://localhost/api/portability/import/plans/${jobId}/attachment-parents${query ? `?${query}` : ""}`,
			{ headers: { "x-user": user }, signal },
		);
	}

	test("uses the captured session owner and returns private advisory results", async () => {
		const request = parentRequest("", "second-owner");
		const result = { items: [], nextAfterOrdinal: null };
		const reply = await app().handle(request);
		expect(reply.status).toBe(200);
		expect(await reply.json()).toEqual(result);
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
		expect(store.parents).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			"second-owner",
			jobId,
			{ afterOrdinal: -1, limit: 64, signal: request.signal },
		);
	});

	test("authenticates and checks origin before discovery", async () => {
		expect((await app().handle(parentRequest("", ""))).status).toBe(401);
		const request = parentRequest();
		request.headers.set("origin", "https://foreign.test");
		expect((await app().handle(request)).status).toBe(403);
		expect(store.parents).not.toHaveBeenCalled();
	});

	test.each([
		["afterOrdinal=-1&limit=1", -1, 1],
		["limit=64&afterOrdinal=50000", 50000, 64],
		["afterOrdinal=0", 0, 64],
		["limit=2", -1, 2],
	] as const)("admits bounded decimal pagination %s", async (query, afterOrdinal, limit) => {
		const request = parentRequest(query);
		expect((await app().handle(request)).status).toBe(200);
		expect(store.parents).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			"caller",
			jobId,
			{ afterOrdinal, limit, signal: request.signal },
		);
	});

	test.each([
		"limit=1&limit=2",
		"afterOrdinal=0&afterOrdinal=1",
		"workspaceId=target",
		"destinationParent=target",
		"ownerId=foreign",
		"limit=0",
		"limit=65",
		"afterOrdinal=-2",
		"afterOrdinal=50001",
		"limit=1.5",
		"afterOrdinal=1.1",
		"limit=NaN",
		"afterOrdinal=9007199254740993",
		"afterOrdinal=1e3",
		"limit=%2B1",
		"limit=0x10",
		"afterOrdinal=",
		"limit=",
		"limit=%201",
		"limit=1&%6cimit=2",
	])("refuses invalid pagination before discovery: %s", async (query) => {
		const reply = await app().handle(parentRequest(query));
		expect(reply.status).toBe(400);
		expect(await reply.json()).toEqual({ code: "invalid-parent-discovery" });
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(store.parents).not.toHaveBeenCalled();
	});

	test("forwards abort to the in-flight helper without retry", async () => {
		const controller = new AbortController();
		const request = parentRequest("", "caller", controller.signal);
		store.parents.mockImplementationOnce(
			(_pool, _owner, _job, options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener(
						"abort",
						() => reject(new ImportPlanStoreError("import-cancelled", 408)),
						{ once: true },
					);
				}),
		);
		const pending = app().handle(request);
		await vi.waitFor(() => expect(store.parents).toHaveBeenCalledTimes(1));
		expect(store.parents.mock.calls[0]?.[3].signal).toBe(request.signal);
		controller.abort();
		const reply = await pending;
		expect(reply.status).toBe(408);
		expect(await reply.json()).toEqual({ code: "import-cancelled" });
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(store.parents).toHaveBeenCalledTimes(1);
	});

	test.each([
		["plan-not-found", 404],
		["import-run-incomplete", 409],
		["parent-evidence-too-large", 413],
		["import-timeout", 503],
	] as const)("preserves helper failure %s", async (code, status) => {
		store.parents.mockRejectedValueOnce(new ImportPlanStoreError(code, status));
		const reply = await app().handle(parentRequest());
		expect(reply.status).toBe(status);
		expect(await reply.json()).toEqual({ code });
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
const reservations = vi.hoisted(() => ({
	reserve: vi.fn(),
	status: vi.fn(),
	inspect: vi.fn(),
	recover: vi.fn(),
}));
vi.mock("./attachment-migration-store.ts", async (original) => {
	const module =
		await original<typeof import("./attachment-migration-store.ts")>();
	return {
		...module,
		reserveAttachmentMigration: reservations.reserve,
		getAttachmentMigrationStatus: reservations.status,
		inspectAttachmentMigration: reservations.inspect,
		recoverAttachmentMigration: reservations.recover,
	};
});
const job = "a".repeat(64);
const reservationURL = `http://localhost/api/portability/import/plans/${job}/attachment-reservations`;
function preparedRequest() {
	return {
		ordinal: 0,
		sourceFingerprint: "b".repeat(64),
		expectedRevision: 0,
		prepared: {
			id: "migration_11111111-1111-4111-8111-111111111111",
			keyVersion: 1,
			filenameCiphertext: "opaque",
			contentTypeCiphertext: "opaque",
			dekWrapped: "opaque",
			declaredBytes: 50,
			ciphertextSha256: "c".repeat(64),
		},
	};
}
function reserveRequest(
	body: BodyInit = JSON.stringify(preparedRequest()),
	extra: Record<string, string> = {},
	url = reservationURL,
	signal?: AbortSignal,
) {
	return new Request(url, {
		method: "POST",
		headers: {
			origin: "http://localhost",
			"x-user": "caller",
			"content-type": "application/json",
			...extra,
		},
		body,
		signal,
		duplex: "half",
	} as RequestInit);
}
describe("attachment reservation transport", () => {
	beforeEach(() => {
		reservations.reserve.mockResolvedValue({ revision: 1 });
		reservations.status.mockResolvedValue({ revision: 1 });
	});
	test("binds session owner and path job, with safe response headers", async () => {
		const response = await app().handle(reserveRequest());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(reservations.reserve.mock.calls[0]?.[1]).toMatchObject({
			ownerId: "caller",
			jobId: job,
			ordinal: 0,
		});
		expect(reservations.reserve.mock.calls[0]?.[2].signal).toBeInstanceOf(
			AbortSignal,
		);
	});
	test.each([
		{ ownerId: "foreign" },
		{ jobId: job },
		{ extra: true },
		{ ordinal: -1 },
		{ ordinal: 50001 },
		{ expectedRevision: -1 },
		{ prepared: { ...preparedRequest().prepared, extra: true } },
	])("strict body rejects %j", async (change) => {
		expect(
			(
				await app().handle(
					reserveRequest(JSON.stringify({ ...preparedRequest(), ...change })),
				)
			).status,
		).toBe(400);
		expect(reservations.reserve).not.toHaveBeenCalled();
	});
	test.each<Record<string, string>>([
		{ origin: "https://foreign.example" },
		{ origin: "" },
		{ "x-user": "" },
	])("uses real guards %j", async (headers) => {
		const response = await app().handle(reserveRequest(undefined, headers));
		expect([401, 403]).toContain(response.status);
		expect(reservations.reserve).not.toHaveBeenCalled();
	});
	test("rejects unsupported type, malformed JSON and oversized streamed body", async () => {
		const api = app();
		expect(
			(await api.handle(reserveRequest("{}", { "content-type": "text/plain" })))
				.status,
		).toBe(415);
		expect((await api.handle(reserveRequest("{"))).status).toBe(400);
		expect(
			(await api.handle(reserveRequest("x".repeat(256 * 1024 + 1)))).status,
		).toBe(413);
		expect(reservations.reserve).not.toHaveBeenCalled();
		expect((await api.handle(reserveRequest())).status).toBe(200);
	});
	test("cancelled request releases budget", async () => {
		const controller = new AbortController();
		controller.abort();
		const api = app();
		expect(
			(
				await api.handle(
					reserveRequest(undefined, {}, reservationURL, controller.signal),
				)
			).status,
		).toBe(408);
		expect(reservations.reserve).not.toHaveBeenCalled();
		expect((await api.handle(reserveRequest())).status).toBe(200);
	});
	test.each([
		"",
		"?ordinal=00",
		"?ordinal=-1",
		"?ordinal=50001",
		"?ordinal=1&ordinal=1",
		"?ordinal=1&extra=x",
		"?ordinal=1.0",
	])("rejects query %s", async (query) => {
		expect(
			(
				await app().handle(
					new Request(reservationURL + query, {
						headers: { "x-user": "caller" },
					}),
				)
			).status,
		).toBe(400);
		expect(reservations.status).not.toHaveBeenCalled();
	});
	test("status forwards session and signal", async () => {
		const response = await app().handle(
			new Request(reservationURL + "?ordinal=50000", {
				headers: { "x-user": "caller" },
			}),
		);
		expect(response.status).toBe(200);
		expect(reservations.status.mock.calls[0]?.slice(1, 4)).toEqual([
			"caller",
			job,
			50000,
		]);
		expect(reservations.status.mock.calls[0]?.[4].signal).toBeInstanceOf(
			AbortSignal,
		);
	});
	test("handled store failures release budget", async () => {
		reservations.reserve.mockRejectedValueOnce(
			new ImportPlanStoreError("migration-conflict", 409),
		);
		const api = app();
		const response = await api.handle(reserveRequest());
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ code: "migration-conflict" });
		expect((await api.handle(reserveRequest())).status).toBe(200);
	});
	test("one per owner and two total share existing apply budget", async () => {
		let release!: (value: unknown) => void;
		reservations.reserve.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const api = app();
		const first = api.handle(reserveRequest());
		for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
		expect(release).toBeTypeOf("function");
		try {
			expect((await api.handle(reserveRequest())).status).toBe(429);
			expect(
				(await api.handle(request(JSON.stringify(payload())))).status,
			).toBe(429);
		} finally {
			release({ revision: 1 });
			await first;
		}
		expect((await api.handle(reserveRequest())).status).toBe(200);
	});
});

test("reservation limits two distinct owners", async () => {
	const releases: ((v: unknown) => void)[] = [];
	reservations.reserve.mockImplementation(
		() =>
			new Promise((resolve) => {
				releases.push(resolve);
			}),
	);
	const api = app();
	const first = api.handle(reserveRequest());
	for (let i = 0; i < 100 && releases.length < 1; i++) await Promise.resolve();
	const second = api.handle(reserveRequest(undefined, { "x-user": "second" }));
	for (let i = 0; i < 100 && releases.length < 2; i++) await Promise.resolve();
	try {
		expect(releases).toHaveLength(2);
		expect(
			(await api.handle(reserveRequest(undefined, { "x-user": "third" })))
				.status,
		).toBe(429);
	} finally {
		for (const release of releases) release({ revision: 1 });
		await Promise.all([first, second]);
	}
});
test("reservation refuses declared overflow and unsafe envelopes", async () => {
	const api = app();
	expect(
		(
			await api.handle(
				reserveRequest("{}", { "content-length": String(256 * 1024 + 1) }),
			)
		).status,
	).toBe(413);
	const body = preparedRequest();
	body.prepared.filenameCiphertext = "bad\0";
	expect((await api.handle(reserveRequest(JSON.stringify(body)))).status).toBe(
		400,
	);
	expect(reservations.reserve).not.toHaveBeenCalled();
});
test("status refuses invalid ID, foreign origin and absent session", async () => {
	reservations.status.mockResolvedValue({ revision: 1 });
	const api = app();
	expect(
		(
			await api.handle(
				new Request(reservationURL.replace(job, "bad") + "?ordinal=0", {
					headers: { "x-user": "caller" },
				}),
			)
		).status,
	).toBe(404);
	expect(
		(
			await api.handle(
				new Request(reservationURL + "?ordinal=0", {
					headers: { "x-user": "caller", origin: "https://foreign.example" },
				}),
			)
		).status,
	).toBe(403);
	expect(
		(await api.handle(new Request(reservationURL + "?ordinal=0"))).status,
	).toBe(401);
	expect(reservations.status).not.toHaveBeenCalled();
});
test("status transports handled error and fails loud without leaked exception", async () => {
	const api = app();
	const get = () =>
		new Request(reservationURL + "?ordinal=0", {
			headers: { "x-user": "caller" },
		});
	reservations.status.mockRejectedValueOnce(
		new ImportPlanStoreError("migration-not-found", 404),
	);
	expect((await api.handle(get())).status).toBe(404);
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		reservations.status.mockRejectedValueOnce(new Error("private-details"));
		const response = await api.handle(get());
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ code: "import-plan-failed" });
		expect(log).toHaveBeenCalledWith("import plan request failed", {
			category: "unexpected",
		});
	} finally {
		log.mockRestore();
	}
});

test("reservation enforces unchanged five-second body deadline", async () => {
	vi.useFakeTimers();
	const api = app();
	let cancelled = false;
	const body = new ReadableStream({
		cancel() {
			cancelled = true;
		},
	});
	const pending = api.handle(reserveRequest(body));
	try {
		await vi.advanceTimersByTimeAsync(5000);
		const response = await pending;
		expect(response.status).toBe(408);
		expect(await response.json()).toEqual({ code: "request-timeout" });
		expect(cancelled).toBe(true);
		expect(reservations.reserve).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});

describe("attachment recovery transport", () => {
	const url = reservationURL.replace(
		"attachment-reservations",
		"attachment-recoveries",
	);
	const inspectionURL = reservationURL.replace(
		"attachment-reservations",
		"attachment-migrations",
	);
	function body() {
		const { expectedRevision: _revision, ...request } = preparedRequest();
		return {
			...request,
			previous: {
				associationId: "22222222-2222-4222-8222-222222222222",
				attemptId: "33333333-3333-4333-8333-333333333333",
				targetAttachmentId: "migration_44444444-4444-4444-8444-444444444444",
				revision: 1,
			},
			retireLive: false,
		};
	}
	beforeEach(() => {
		reservations.reserve.mockResolvedValue({ revision: 1 });
		reservations.recover.mockResolvedValue({
			outcome: "reserved",
			status: { revision: 2 },
		});
		reservations.inspect.mockResolvedValue({ revision: 1, recoverable: true });
	});
	test("inspection forwards captured owner, exact ordinal and cancellation privately", async () => {
		const request = new Request(`${inspectionURL}?ordinal=7`, {
			headers: { "x-user": "caller" },
		});
		const reply = await app().handle(request);
		expect(reply.status).toBe(200);
		expect(await reply.json()).toEqual({ revision: 1, recoverable: true });
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reservations.inspect).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			"caller",
			job,
			7,
			{ signal: request.signal },
		);
	});
	test.each([
		"",
		"?ordinal=01",
		"?ordinal=1&ownerId=other",
		"?ordinal=1&ordinal=2",
	])("rejects invalid inspection selector %s", async (query) => {
		expect(
			(
				await app().handle(
					new Request(`${inspectionURL}${query}`, {
						headers: { "x-user": "caller" },
					}),
				)
			).status,
		).toBe(400);
		expect(reservations.inspect).not.toHaveBeenCalled();
	});
	test("recovery passes only validated witness and captured authority", async () => {
		const request = reserveRequest(JSON.stringify(body()), {}, url);
		const reply = await app().handle(request);
		expect(reply.status).toBe(200);
		expect(reply.headers.get("cache-control")).toBe("no-store");
		expect(reservations.recover).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			{
				...body(),
				prepared: {
					...body().prepared,
					thumbnailDeclaredBytes: null,
					thumbnailCiphertextSha256: null,
				},
				ownerId: "caller",
				jobId: job,
			},
			{ signal: request.signal },
		);
	});
	test.each([
		{ ownerId: "foreign" },
		{ jobId: job },
		{ expectedRevision: 1 },
		{ retireLive: undefined },
		{ retireLive: "true" },
		{ previous: { ...body().previous, revision: 0 } },
		{ previous: { ...body().previous, attemptId: null } },
		{ previous: { ...body().previous, extra: true } },
		{ prepared: { ...body().prepared, extra: true } },
	])("rejects untrusted recovery fields %j", async (change) => {
		const reply = await app().handle(
			reserveRequest(JSON.stringify({ ...body(), ...change }), {}, url),
		);
		expect(reply.status).toBe(400);
		expect(await reply.json()).toEqual({ code: "invalid-migration-recovery" });
		expect(reservations.recover).not.toHaveBeenCalled();
	});
	test.each<Record<string, string>>([
		{ origin: "https://foreign.example" },
		{ origin: "" },
		{ "x-user": "" },
	])("guards recovery before reading %j", async (headers) => {
		expect([401, 403]).toContain(
			(await app().handle(reserveRequest("{", headers, url))).status,
		);
		expect(reservations.recover).not.toHaveBeenCalled();
	});
	test("recovery retains shared admission until the operation settles", async () => {
		const pending = Promise.withResolvers<unknown>();
		reservations.recover.mockReturnValueOnce(pending.promise);
		const api = app();
		const recovery = api.handle(
			reserveRequest(JSON.stringify(body()), {}, url),
		);
		try {
			await vi.waitFor(() =>
				expect(reservations.recover).toHaveBeenCalledTimes(1),
			);
			expect((await api.handle(reserveRequest())).status).toBe(429);
		} finally {
			pending.resolve({ outcome: "reserved", status: { revision: 2 } });
			await recovery;
		}
		expect((await recovery).status).toBe(200);
		expect((await api.handle(reserveRequest())).status).toBe(200);
	});
	test("propagates recovery conflict without exposing storage details", async () => {
		reservations.recover.mockRejectedValueOnce(
			new ImportPlanStoreError("migration-revision-conflict", 409),
		);
		const reply = await app().handle(
			reserveRequest(JSON.stringify(body()), {}, url),
		);
		expect(reply.status).toBe(409);
		expect(await reply.json()).toEqual({ code: "migration-revision-conflict" });
	});
});

test("separate browser route instances can share application import admission", async () => {
	const admission = createImportAdmission();
	const guards = makeGuards(
		["http://localhost"],
		async () => ({ user: { id: "caller" } }) as Session,
	);
	const first = new Elysia().use(
		importPlanRoutes({} as Pool, guards, admission),
	);
	const second = new Elysia().use(
		importPlanRoutes({} as Pool, guards, admission),
	);
	let release!: (value: unknown) => void;
	store.save.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const pending = first.handle(request());
	await vi.waitFor(() => expect(release).toBeDefined());
	expect((await second.handle(request())).status).toBe(429);
	release({ id: "saved", report: { plannerVersion: 4, applySupported: true } });
	expect((await pending).status).toBe(200);
	expect(admission.size).toBe(0);
});
