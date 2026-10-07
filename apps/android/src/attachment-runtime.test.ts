import { expect, test, vi } from "vitest";
import { deleteAttachment } from "../../../src/web/lib/e2e/attachment-api.ts";
import { createAttachmentRuntime } from "./attachment-runtime.ts";
import type { callAttachment } from "./bridge.ts";

type Reply = Awaited<ReturnType<typeof callAttachment>>;
const successful: Reply = { ok: true, status: 200, body: "{}" };
function harness(handler: typeof callAttachment) {
	let current = true;
	const call = vi.fn(handler);
	const runtime = createAttachmentRuntime(
		() => {
			if (!current) throw new Error("retired");
		},
		"account-A",
		true,
		call,
	);
	return {
		runtime,
		call,
		retire() {
			current = false;
		},
	};
}
async function reserve(
	runtime: ReturnType<typeof createAttachmentRuntime>,
	bytes: number,
) {
	await runtime.fetcher("/api/attachments/reserve", {
		method: "POST",
		body: JSON.stringify({ id: "file-A", declaredBytes: bytes }),
	});
}
test("file bridge refuses caller URLs, headers, and unreserved upload streams", async () => {
	const { runtime, call } = harness(async () => successful);
	for (const target of [
		"https://example.test/api/attachments/config",
		"/api/attachments/config?other",
		"/api/attachments/%2e%2e/download",
	])
		await expect(runtime.fetcher(target)).rejects.toThrow();
	await expect(
		runtime.fetcher("/api/attachments/config", {
			headers: { Authorization: "caller-token" },
		}),
	).rejects.toThrow();
	await expect(
		runtime.fetcher("/api/attachments/file-A/upload", {
			method: "POST",
			body: new ReadableStream(),
		}),
	).rejects.toThrow();
	expect(call).not.toHaveBeenCalled();
});
test("upload applies 32 KiB backpressure and cancels native transfer on interrupted write", async () => {
	let release!: () => void;
	const { runtime, call } = harness(async (op) => {
		if (op === "upload.begin") return { ok: true, transferId: "transfer-A" };
		if (op === "upload.write")
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		return successful;
	});
	await reserve(runtime, 65536);
	const controller = new AbortController();
	const task = runtime.fetcher("/api/attachments/file-A/upload", {
		method: "POST",
		signal: controller.signal,
		body: new ReadableStream({
			start(c) {
				c.enqueue(new Uint8Array(65536));
				c.close();
			},
		}),
	});
	await vi.waitFor(() =>
		expect(
			call.mock.calls.filter(([op]) => op === "upload.write"),
		).toHaveLength(1),
	);
	const write = call.mock.calls.find(([op]) => op === "upload.write")?.[1];
	expect(atob(String(write?.data))).toHaveLength(32768);
	controller.abort();
	release();
	await expect(task).rejects.toMatchObject({ name: "AbortError" });
	expect(call.mock.calls.filter(([op]) => op === "upload.write")).toHaveLength(
		1,
	);
	expect(call.mock.calls.some(([op]) => op === "attachment.cancel")).toBe(true);
	expect(call.mock.calls.some(([op]) => op === "upload.finish")).toBe(false);
});
test("download reads only on demand and cancellation releases its capability", async () => {
	const { runtime, call } = harness(async (op) =>
		op === "download.begin"
			? { ok: true, status: 200, transferId: "transfer-A", bytes: 2 }
			: op === "download.read"
				? { ok: true, data: btoa("ok"), eof: false }
				: successful,
	);
	const response = await runtime.fetcher("/api/attachments/file-A/download");
	expect(call.mock.calls.some(([op]) => op === "download.read")).toBe(false);
	if (!response.body) throw new Error("missing download body");
	const reader = response.body.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe("ok");
	expect(call.mock.calls.filter(([op]) => op === "download.read")).toHaveLength(
		1,
	);
	await reader.cancel();
	expect(call.mock.calls.at(-1)?.[0]).toBe("attachment.cancel");
});
test("malformed native stream fails and releases without emitting bytes", async () => {
	const { runtime, call } = harness(async (op) =>
		op === "download.begin"
			? { ok: true, status: 200, transferId: "transfer-A" }
			: op === "download.read"
				? { ok: true, data: "invalid!", eof: false }
				: successful,
	);
	const response = await runtime.fetcher("/api/attachments/file-A/download");
	await expect(response.arrayBuffer()).rejects.toThrow("chunk refused");
	expect(call.mock.calls.at(-1)?.[0]).toBe("attachment.cancel");
});
test("old account cannot retarget a stream or cancellation to its replacement", async () => {
	const h = harness(async (op) =>
		op === "download.begin"
			? { ok: true, status: 200, transferId: "transfer-A" }
			: successful,
	);
	const response = await h.runtime.fetcher("/api/attachments/file-A/download");
	h.retire();
	await expect(response.arrayBuffer()).rejects.toThrow("retired");
	expect(h.call).toHaveBeenCalledTimes(1);
});
test("canceling an outstanding chooser frees pending ownership and any late result", async () => {
	let selected!: (value: Reply) => void;
	const { runtime, call } = harness(async (op) =>
		op === "save.pick"
			? new Promise<Reply>((resolve) => {
					selected = resolve;
				})
			: successful,
	);
	const controller = new AbortController();
	const picking = runtime.pickFile("garden.txt", controller.signal);
	controller.abort();
	await expect(picking).rejects.toMatchObject({ name: "AbortError" });
	expect(call.mock.calls.some(([op]) => op === "save.cancelPending")).toBe(
		true,
	);
	selected({ ok: true, saveId: "save-A" });
	await vi.waitFor(() =>
		expect(
			call.mock.calls.some(
				([op, body]) => op === "save.cancel" && body?.saveId === "save-A",
			),
		).toBe(true),
	);
});
test("desktop ciphertext stage rewinds independently for both integrity passes and cleans up", async () => {
	let reads = 0;
	const { runtime, call } = harness(async (op) =>
		op === "stage.begin"
			? { ok: true, stageId: "stage-A" }
			: op === "stage.read"
				? {
						ok: true,
						data: reads++ % 2 === 0 ? btoa("ciphertext") : "",
						eof: reads % 2 === 0,
					}
				: successful,
	);
	await runtime.withStage(async (stage) => {
		const writer = await stage.createWritable();
		await writer.write(new Uint8Array([1, 2]));
		await writer.close();
		const snapshot = await stage.getFile();
		for (let pass = 0; pass < 2; pass++)
			expect(await new Response(snapshot.stream()).text()).toBe("ciphertext");
	});
	expect(call.mock.calls.filter(([op]) => op === "stage.rewind")).toHaveLength(
		2,
	);
	expect(call.mock.calls.at(-1)?.[0]).toBe("stage.cancel");
});

test("native deletion uses the shared API canonical fixed POST route", async () => {
	const { runtime, call } = harness(async () => ({
		ok: true,
		status: 200,
		body: JSON.stringify({ id: "file-A", state: "deleting" }),
	}));
	await expect(deleteAttachment("file-A", runtime.fetcher)).resolves.toEqual({
		id: "file-A",
		state: "deleting",
	});
	expect(call).toHaveBeenCalledWith("attachment.delete", { id: "file-A" });
});

function archiveHarness(handler: typeof callAttachment) {
	let current = true;
	const call = vi.fn(handler);
	const runtime = createAttachmentRuntime(
		() => {
			if (!current) throw new Error("retired");
		},
		"account-A",
		true,
		call,
		true,
	);
	return {
		runtime,
		call,
		retire() {
			current = false;
		},
	};
}
test("archive export is explicit capability and never a generic fetch route", async () => {
	const call = vi.fn(async () => successful);
	expect(
		createAttachmentRuntime(() => {}, "a", true, call).archiveExport,
	).toBeUndefined();
	expect(
		createAttachmentRuntime(() => {}, "a", false, call, true).archiveExport,
	).toBeUndefined();
	const h = archiveHarness(async () => successful);
	await expect(
		h.runtime.fetcher("/api/native/portability/export"),
	).rejects.toThrow("target refused");
	expect(h.call).not.toHaveBeenCalled();
});
test("archive reader joins bounded UTF-8 chunks exactly including a split scalar", async () => {
	const raw = new TextEncoder().encode('{"text":"😀"}');
	const h = archiveHarness(async (op, body) => {
		if (op === "archive.export.begin")
			return { ok: true, transferId: "archive-A", bytes: raw.length };
		if (op === "archive.export.read") {
			const seq = Number(body?.seq);
			const bytes =
				seq === 0
					? raw.slice(0, 11)
					: seq === 1
						? raw.slice(11)
						: new Uint8Array();
			return {
				ok: true,
				data: btoa(String.fromCharCode(...bytes)),
				eof: seq === 2,
			};
		}
		return successful;
	});
	expect(await h.runtime.archiveExport?.readContent()).toBe('{"text":"😀"}');
	expect(h.call).toHaveBeenCalledWith("archive.export.begin", {});
	expect(h.call.mock.calls.at(-1)).toEqual([
		"attachment.cancel",
		{ transferId: "archive-A" },
	]);
});
test("archive reader rejects oversize, invalid UTF-8 and incomplete byte counts", async () => {
	for (const mode of ["oversize", "utf8", "incomplete"]) {
		const h = archiveHarness(async (op) =>
			op === "archive.export.begin"
				? {
						ok: true,
						transferId: "archive-A",
						bytes: mode === "oversize" ? 32 * 1024 * 1024 + 1 : 1,
					}
				: op === "archive.export.read"
					? {
							ok: true,
							data: mode === "utf8" ? "/w==" : "",
							eof: mode !== "utf8",
						}
					: successful,
		);
		await expect(h.runtime.archiveExport?.readContent()).rejects.toThrow();
		expect(h.call.mock.calls.at(-1)?.[0]).toBe("attachment.cancel");
	}
});
test("archive abort cancels pending read and late reply cannot expose content", async () => {
	let resolve!: (reply: Reply) => void;
	const h = archiveHarness(async (op) =>
		op === "archive.export.begin"
			? new Promise<Reply>((r) => {
					resolve = r;
				})
			: successful,
	);
	const controller = new AbortController();
	const reading = h.runtime.archiveExport?.readContent(controller.signal);
	await expect(h.runtime.archiveExport?.readContent()).rejects.toThrow("busy");
	controller.abort();
	expect(h.call).toHaveBeenCalledWith("archive.export.cancelPending", {});
	resolve({ ok: true, transferId: "archive-A", bytes: 0 });
	await expect(reading).rejects.toMatchObject({ name: "AbortError" });
	expect(h.call.mock.calls.at(-1)?.[0]).toBe("attachment.cancel");
});
test("archive retirement never addresses replacement owner", async () => {
	let resolve!: (reply: Reply) => void;
	const h = archiveHarness(
		async () =>
			new Promise<Reply>((r) => {
				resolve = r;
			}),
	);
	const reading = h.runtime.archiveExport?.readContent();
	h.retire();
	resolve({ ok: true, transferId: "archive-A", bytes: 0 });
	await expect(reading).rejects.toThrow("retired");
	expect(h.call).toHaveBeenCalledTimes(1);
});
