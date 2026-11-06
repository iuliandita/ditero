import type { Pool } from "pg";
import { expect, test, vi } from "vitest";

const exports = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./export.ts", async (original) => ({
	...(await original<typeof import("./export.ts")>()),
	exportPortableJson: exports.run,
	exportPortableJsonV2: exports.run,
}));

import { createPortabilityExporter } from "./routes.ts";

test("admits eight export users while retaining one slot per user across versions", async () => {
	const finish: ((body: string) => void)[] = [];
	exports.run.mockImplementation(
		() => new Promise((resolve) => finish.push(resolve)),
	);
	const exporter = createPortabilityExporter({} as Pool);
	const request = new Request("http://localhost/api/portability/export");
	const pending = Array.from({ length: 8 }, (_, index) =>
		exporter(request, `user-${index}`, index % 2 ? 1 : 2),
	);
	try {
		expect(finish).toHaveLength(8);
		expect((await exporter(request, "user-0", 1)).status).toBe(429);
		expect((await exporter(request, "ninth", 1)).status).toBe(429);
	} finally {
		for (const resolve of finish) resolve("{}");
		expect(
			(await Promise.all(pending)).map((response) => response.status),
		).toEqual(Array(8).fill(200));
	}
	exports.run.mockResolvedValueOnce("{}");
	expect((await exporter(request, "user-0", 1)).status).toBe(200);
});
