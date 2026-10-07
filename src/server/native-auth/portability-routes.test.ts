import { Elysia } from "elysia";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserContextError } from "../../db/user-context.ts";
import { makeGuards, type Session } from "../guards.ts";
import {
	ExportInterruptedError,
	ExportLimitError,
} from "../portability/export.ts";
import { ImportPlanStoreError } from "../portability/import-plan-store.ts";
import {
	createImportAdmission,
	importPlanRoutes,
} from "../portability/import-routes.ts";
import {
	createPortabilityExporter,
	portabilityRoutes,
} from "../portability/routes.ts";
import { nativePortabilityRoutes } from "./portability-routes.ts";

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	v1: vi.fn(),
	v2: vi.fn(),
	jobs: vi.fn(),
	parents: vi.fn(),
	inspect: vi.fn(),
	status: vi.fn(),
	reserve: vi.fn(),
	recover: vi.fn(),
	apply: vi.fn(),
}));
vi.mock("../portability/import-plan-store.ts", async (original) => ({
	...(await original<object>()),
	listCompletedAttachmentImportJobs: mocks.jobs,
}));
vi.mock("../portability/attachment-migration-parents.ts", () => ({
	getAttachmentMigrationParents: mocks.parents,
}));
vi.mock("../portability/attachment-migration-store.ts", async (original) => ({
	...(await original<object>()),
	inspectAttachmentMigration: mocks.inspect,
	getAttachmentMigrationStatus: mocks.status,
	reserveAttachmentMigration: mocks.reserve,
	recoverAttachmentMigration: mocks.recover,
}));
vi.mock("../portability/import-apply-store.ts", async (original) => ({
	...(await original<object>()),
	applyImportBatch: mocks.apply,
}));
vi.mock("./session.ts", () => ({ authenticateNative: mocks.auth }));
vi.mock("../portability/export.ts", async (original) => ({
	...(await original<object>()),
	exportPortableJson: mocks.v1,
	exportPortableJsonV2: mocks.v2,
}));
const pool = {} as Pool;
const request = (
	path: string,
	user = "a",
	headers: Record<string, string> = {},
) =>
	new Request(`http://localhost${path}`, {
		headers: { authorization: `Bearer ${user}`, ...headers },
	});
function setup() {
	const exporter = createPortabilityExporter(pool);
	const rateLimit = vi.fn().mockResolvedValue(true);
	const guards = makeGuards(
		["http://localhost"],
		async (headers) =>
			({ user: { id: headers.get("authorization")?.slice(7) } }) as Session,
	);
	const admission = createImportAdmission();
	const app = new Elysia()
		.use(importPlanRoutes(pool, guards, admission))
		.use(portabilityRoutes(pool, guards, {}, exporter))
		.use(nativePortabilityRoutes({ pool, exporter, rateLimit, admission }));
	return { app, rateLimit, exporter };
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.auth.mockImplementation(async (_pool, headers: Headers) =>
		headers.get("authorization")
			? { userId: headers.get("authorization")?.slice(7) }
			: null,
	);
	for (const operation of [
		mocks.parents,
		mocks.inspect,
		mocks.status,
		mocks.reserve,
		mocks.recover,
	])
		operation.mockResolvedValue({ ok: true });
	mocks.jobs.mockResolvedValue({ items: [], nextAfterJobId: null });
	mocks.v1.mockResolvedValue('{"version":1}');
	mocks.v2.mockResolvedValue('{"version":2,"exact":"bytes"}');
});
describe("native portability export", () => {
	it("returns exact v2 bytes and retains browser version selection", async () => {
		const { app } = setup();
		const native = await app.handle(
			request("/api/native/portability/export?version=1"),
		);
		expect(native.status).toBe(200);
		expect(await native.text()).toBe('{"version":2,"exact":"bytes"}');
		expect(native.headers.get("cache-control")).toBe("no-store");
		expect(native.headers.get("x-content-type-options")).toBe("nosniff");
		expect(native.headers.get("content-disposition")).toContain(
			"ditero-history-v2.json",
		);
		expect(mocks.v2).toHaveBeenCalledWith(
			pool,
			"a",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(
			await (await app.handle(request("/api/portability/export"))).text(),
		).toBe('{"version":1}');
		expect(
			await (
				await app.handle(request("/api/portability/export?version=2"))
			).text(),
		).toContain('"version":2');
		expect(
			(await app.handle(request("/api/portability/export?version=3"))).status,
		).toBe(400);
	});
	it.each([
		"origin",
		"cookie",
	])("rejects even an empty %s before auth and rate limiting", async (header) => {
		const { app, rateLimit } = setup();
		expect(
			(
				await app.handle(
					request("/api/native/portability/export", "a", { [header]: "" }),
				)
			).status,
		).toBe(400);
		expect(rateLimit).not.toHaveBeenCalled();
		expect(mocks.auth).not.toHaveBeenCalled();
		expect(mocks.v2).not.toHaveBeenCalled();
	});
	it("requires native authentication and rate admission", async () => {
		const { app, rateLimit } = setup();
		expect(
			(
				await app.handle(
					new Request("http://localhost/api/native/portability/export"),
				)
			).status,
		).toBe(401);
		rateLimit.mockResolvedValue(false);
		const limited = await app.handle(request("/api/native/portability/export"));
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("5");
		expect(mocks.v2).not.toHaveBeenCalled();
	});
	it("shares per-user and global admission across browser and native routes", async () => {
		const { app } = setup();
		let releaseA!: (body: string) => void;
		let releaseB!: (body: string) => void;
		mocks.v1.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					releaseA = resolve;
				}),
		);
		mocks.v2.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					releaseB = resolve;
				}),
		);
		const a = app.handle(request("/api/portability/export", "a"));
		await vi.waitFor(() => expect(releaseA).toBeDefined());
		expect(
			(await app.handle(request("/api/native/portability/export", "a"))).status,
		).toBe(429);
		const b = app.handle(request("/api/native/portability/export", "b"));
		await vi.waitFor(() => expect(releaseB).toBeDefined());
		expect(
			(await app.handle(request("/api/portability/export", "c"))).status,
		).toBe(429);
		releaseA("{}");
		releaseB("{}");
		expect((await a).status).toBe(200);
		expect((await b).status).toBe(200);
		expect(
			(await app.handle(request("/api/native/portability/export", "a"))).status,
		).toBe(200);
	});
	it.each([
		[new ExportInterruptedError("export-timeout"), 503, "export-timeout"],
		[new ExportInterruptedError("export-cancelled"), 408, "export-cancelled"],
		[new ExportLimitError(), 413, "export-limit-exceeded"],
		[new UserContextError(), 401, "unauthorized"],
	])("preserves export errors and releases admission", async (error, status, code) => {
		const { app } = setup();
		mocks.v2.mockRejectedValueOnce(error);
		const failed = await app.handle(request("/api/native/portability/export"));
		expect(failed.status).toBe(status);
		expect(await failed.json()).toEqual({ code });
		expect(
			(await app.handle(request("/api/native/portability/export"))).status,
		).toBe(200);
	});
	it("keeps unexpected errors private", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { app } = setup();
			mocks.v2.mockRejectedValueOnce(new Error("private database payload"));
			const failed = await app.handle(
				request("/api/native/portability/export"),
			);
			expect(failed.status).toBe(500);
			expect(await failed.json()).toEqual({ code: "export-failed" });
			expect(JSON.stringify(log.mock.calls)).not.toContain(
				"private database payload",
			);
		} finally {
			log.mockRestore();
		}
	});
	it("does not share admission between separately constructed exporters", async () => {
		let release!: (body: string) => void;
		mocks.v2.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const first = createPortabilityExporter(pool)(request("/"), "a", 2);
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(
			(await createPortabilityExporter(pool)(request("/"), "a", 2)).status,
		).toBe(200);
		release("{}");
		await first;
	});
});

const jobId = "a".repeat(64);
const migrationBody = {
	ordinal: 0,
	sourceFingerprint: "b".repeat(64),
	expectedRevision: 0,
	prepared: {
		id: "migration_11111111-1111-4111-8111-111111111111",
		keyVersion: 1,
		filenameCiphertext: "name",
		contentTypeCiphertext: "type",
		dekWrapped: "wrapped",
		thumbnailDeclaredBytes: null,
		thumbnailCiphertextSha256: null,
		declaredBytes: 50,
		ciphertextSha256: "c".repeat(64),
	},
};
const migrationRequest = (
	action: string,
	body?: unknown,
	user = "a",
	extra: Record<string, string> = {},
) =>
	new Request(
		`http://localhost/api/native/portability/import/plans/${jobId}/${action}`,
		{
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${user}`,
				"content-type": "application/json",
				...extra,
			},
			...(body === undefined
				? {}
				: { body: typeof body === "string" ? body : JSON.stringify(body) }),
		},
	);
describe("native attachment migration", () => {
	it("uses native session owner and fixed store handlers", async () => {
		const { app } = setup();
		for (const [action, operation] of [
			["attachment-parents?afterOrdinal=-1&limit=2", mocks.parents],
			["attachment-migrations?ordinal=0", mocks.inspect],
			["attachment-reservations?ordinal=0", mocks.status],
		] as const) {
			const response = await app.handle(migrationRequest(action));
			expect(response.status).toBe(200);
			expect(operation.mock.calls[0]?.slice(0, 3)).toEqual([pool, "a", jobId]);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations", migrationBody),
				)
			).status,
		).toBe(200);
		expect(mocks.reserve).toHaveBeenCalledWith(
			pool,
			expect.objectContaining({ ownerId: "a", jobId, ...migrationBody }),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const recovery = {
			ordinal: 0,
			sourceFingerprint: migrationBody.sourceFingerprint,
			previous: {
				associationId: "11111111-1111-4111-8111-111111111111",
				attemptId: "22222222-2222-4222-8222-222222222222",
				targetAttachmentId: "migration_33333333-3333-4333-8333-333333333333",
				revision: 1,
			},
			prepared: migrationBody.prepared,
			retireLive: true,
		};
		expect(
			(await app.handle(migrationRequest("attachment-recoveries", recovery)))
				.status,
		).toBe(200);
		expect(mocks.recover).toHaveBeenCalledWith(
			pool,
			expect.objectContaining({ ownerId: "a", jobId, ...recovery }),
			expect.anything(),
		);
	});
	it("bounds completed-job queries and rejects unknown or duplicate fields", async () => {
		const { app } = setup();
		const response = await app.handle(
			request(
				`/api/native/portability/import/jobs?afterJobId=${jobId}&limit=2`,
			),
		);
		expect(response.status).toBe(200);
		expect(mocks.jobs).toHaveBeenCalledWith(
			pool,
			"a",
			{ afterJobId: jobId, limit: 2 },
			expect.any(AbortSignal),
		);
		for (const query of [
			"limit=0",
			"limit=65",
			"limit=1&limit=2",
			"ownerId=other",
			"afterJobId=bad",
			"limit=1.5",
		]) {
			expect(
				(
					await app.handle(
						request(`/api/native/portability/import/jobs?${query}`),
					)
				).status,
			).toBe(400);
		}
		expect(mocks.jobs).toHaveBeenCalledTimes(1);
	});
	it("refuses malformed queries, credentials and bodies before store mutations", async () => {
		const { app } = setup();
		for (const query of [
			"ordinal=0&ordinal=1",
			"ordinal=0&ownerId=other",
			"ordinal=-1",
			"ordinal=50001",
		]) {
			expect(
				(await app.handle(migrationRequest(`attachment-migrations?${query}`)))
					.status,
			).toBe(400);
		}
		for (const header of ["cookie", "origin"]) {
			expect(
				(
					await app.handle(
						migrationRequest("attachment-reservations", migrationBody, "a", {
							[header]: "",
						}),
					)
				).status,
			).toBe(400);
		}
		for (const body of [
			"{",
			{ ...migrationBody, ownerId: "other" },
			{ ...migrationBody, path: "/tmp/file" },
			JSON.stringify(migrationBody).replace(
				'"ordinal":0',
				'"ordinal":0,"\\u006frdinal":0',
			),
			JSON.stringify(migrationBody).replace(
				'"keyVersion":1',
				'"keyVersion":1,"keyVersion":1',
			),
		]) {
			expect(
				(await app.handle(migrationRequest("attachment-reservations", body)))
					.status,
			).toBe(400);
		}
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations?unknown=1", migrationBody),
				)
			).status,
		).toBe(400);
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations", " ".repeat(262145)),
				)
			).status,
		).toBe(413);
		expect(mocks.reserve).not.toHaveBeenCalled();
		expect(mocks.inspect).not.toHaveBeenCalled();
	});
	it("preserves store refusals and releases shared browser/native mutation admission", async () => {
		const { app } = setup();
		let release!: (value: unknown) => void;
		mocks.apply.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const browser = app.handle(
			new Request(
				`http://localhost/api/portability/import/plans/${jobId}/apply`,
				{
					method: "POST",
					headers: {
						origin: "http://localhost",
						authorization: "Bearer a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						planDigest: jobId,
						counts: { ensure: 1, ignored: 0, blocked: 0 },
					}),
				},
			),
		);
		await vi.waitFor(() => expect(release).toBeDefined());
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations", migrationBody),
				)
			).status,
		).toBe(429);
		release({ state: "completed" });
		expect((await browser).status).toBe(200);
		mocks.reserve.mockRejectedValueOnce(
			new ImportPlanStoreError("migration-revision-conflict", 409),
		);
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations", migrationBody),
				)
			).status,
		).toBe(409);
		expect(
			(
				await app.handle(
					migrationRequest("attachment-reservations", migrationBody),
				)
			).status,
		).toBe(200);
	});
	it("cancels an incomplete body without entering the store", async () => {
		const { app } = setup();
		const abort = new AbortController();
		const pending = app.handle(
			new Request(
				`http://localhost/api/native/portability/import/plans/${jobId}/attachment-reservations`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer a",
						"content-type": "application/json",
					},
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"ordinal":'));
						},
					}),
					signal: abort.signal,
					duplex: "half",
				} as RequestInit,
			),
		);
		await vi.waitFor(() => expect(mocks.auth).toHaveBeenCalled());
		abort.abort();
		expect((await pending).status).toBe(408);
		expect(mocks.reserve).not.toHaveBeenCalled();
	});
});
