import { Elysia } from "elysia";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserContextError } from "../../db/user-context.ts";
import { makeGuards, type Session } from "../guards.ts";
import {
	ExportInterruptedError,
	ExportLimitError,
} from "../portability/export.ts";
import {
	createPortabilityExporter,
	portabilityRoutes,
} from "../portability/routes.ts";
import { nativePortabilityRoutes } from "./portability-routes.ts";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), v1: vi.fn(), v2: vi.fn() }));
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
	const app = new Elysia()
		.use(portabilityRoutes(pool, guards, {}, exporter))
		.use(nativePortabilityRoutes({ pool, exporter, rateLimit }));
	return { app, rateLimit, exporter };
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.auth.mockImplementation(async (_pool, headers: Headers) =>
		headers.get("authorization")
			? { userId: headers.get("authorization")?.slice(7) }
			: null,
	);
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
