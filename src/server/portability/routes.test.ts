import type { Pool } from "pg";
import { beforeEach, expect, test, vi } from "vitest";

const exports = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./export.ts", async (original) => ({
	...(await original<typeof import("./export.ts")>()),
	exportPortableJson: exports.run,
	exportPortableJsonV2: exports.run,
}));

import {
	acquirePortabilityConnection,
	portabilityAdmission,
} from "./admission.ts";
import { createPortabilityExporter } from "./routes.ts";

beforeEach(() => {
	vi.resetAllMocks();
});

test("admits three export users while retaining one slot per user across versions", async () => {
	const finish: ((body: string) => void)[] = [];
	exports.run.mockImplementation(
		() => new Promise((resolve) => finish.push(resolve)),
	);
	const exporter = createPortabilityExporter({} as Pool);
	const request = new Request("http://localhost/api/portability/export");
	const pending = Array.from({ length: 3 }, (_, index) =>
		exporter(request, `user-${index}`, index % 2 ? 1 : 2),
	);
	try {
		expect(finish).toHaveLength(3);
		expect((await exporter(request, "user-0", 1)).status).toBe(429);
		exports.run.mockResolvedValueOnce("{}");
		expect((await exporter(request, "fourth", 1)).status).toBe(429);
	} finally {
		for (const resolve of finish) resolve("{}");
		expect(
			(await Promise.all(pending)).map((response) => response.status),
		).toEqual(Array(3).fill(200));
	}
	exports.run.mockResolvedValueOnce("{}");
	expect((await exporter(request, "user-0", 1)).status).toBe(200);
});

test("shares import/export admission and connection budgets across exporter instances", async () => {
	const pool = {} as Pool;
	const request = new Request("http://localhost/api/portability/export");
	const admission = portabilityAdmission(pool);
	admission.add("import-a");
	admission.add("import-b");
	const releaseA = acquirePortabilityConnection(pool, "import-a");
	const releaseB = acquirePortabilityConnection(pool, "import-b");
	let finish!: (body: string) => void;
	exports.run.mockImplementationOnce(
		() =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	);
	const exportC = createPortabilityExporter(pool)(request, "export-c", 2);
	try {
		expect(finish).toBeDefined();
		expect(
			(await createPortabilityExporter(pool)(request, "import-a", 1)).status,
		).toBe(429);
		exports.run.mockResolvedValueOnce("{}");
		expect(
			(await createPortabilityExporter(pool)(request, "fourth", 1)).status,
		).toBe(429);
		expect(acquirePortabilityConnection(pool, "status-d")).toBeNull();
	} finally {
		finish("{}");
		await exportC;
		admission.clear();
		releaseA?.();
		releaseB?.();
	}
	exports.run.mockResolvedValueOnce("{}");
	expect(
		(await createPortabilityExporter(pool)(request, "import-a", 1)).status,
	).toBe(200);
});
