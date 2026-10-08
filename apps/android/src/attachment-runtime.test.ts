import { expect, test, vi } from "vitest";
import { deleteAttachment } from "../../../src/web/lib/e2e/attachment-api.ts";
import { FilePickerCancelledError } from "../../../src/web/lib/e2e/download.ts";
import { createAttachmentRuntime } from "./attachment-runtime.ts";
import { type callAttachment, NativeError } from "./bridge.ts";

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

const inputReady = {
	ok: true,
	transferId: "input-A",
	bytes: 0,
	name: "archive.json",
};
test("archive input requires explicit desktop capability", () => {
	const call = vi.fn(async () => successful);
	expect(
		createAttachmentRuntime(() => {}, "a", true, call, true).archiveInput,
	).toBeUndefined();
	expect(
		createAttachmentRuntime(() => {}, "a", false, call, false, true)
			.archiveInput,
	).toBeUndefined();
});
test("archive input reads both kinds with ordered split UTF-8 chunks and empty EOF", async () => {
	for (const kind of ["content", "archive"] as const) {
		const raw = new TextEncoder().encode("a😀b");
		const h = archiveHarness(async (op, body) => {
			if (op === "archive.input.pick")
				return { ...inputReady, bytes: raw.length };
			if (op === "archive.input.read") {
				const seq = Number(body?.seq);
				const bytes =
					seq === 0
						? raw.slice(0, 3)
						: seq === 1
							? raw.slice(3)
							: new Uint8Array();
				return {
					ok: true,
					data: btoa(String.fromCharCode(...bytes)),
					eof: seq === 2,
				};
			}
			return successful;
		});
		const picked = await h.runtime.archiveInput?.readDocument(kind);
		expect(picked).toEqual({ text: "a😀b", name: "archive.json" });
		expect(Object.isFrozen(picked)).toBe(true);
		expect(h.call).toHaveBeenCalledWith("archive.input.pick", { kind });
		expect(
			h.call.mock.calls
				.filter(([op]) => op === "archive.input.read")
				.map(([, body]) => body?.seq),
		).toEqual([0, 1, 2]);
		expect(h.call.mock.calls.at(-1)).toEqual([
			"archive.input.cancel",
			{ transferId: "input-A" },
		]);
	}
});
test("archive input rejects hostile metadata and chunk/count/UTF-8/EOF violations", async () => {
	for (const mode of [
		"oversize",
		"fraction",
		"name",
		"utf8",
		"count",
		"empty",
		"trailing",
		"base64",
		"chunk",
		"eof",
	]) {
		const h = archiveHarness(async (op) => {
			if (op === "archive.input.pick")
				return {
					...inputReady,
					bytes:
						mode === "oversize"
							? 33554433
							: mode === "fraction"
								? 0.5
								: mode === "trailing"
									? 0
									: 1,
					name: mode === "name" ? "../archive.json" : "archive.json",
				};
			if (op === "archive.input.read")
				return {
					ok: true,
					data:
						mode === "utf8"
							? "/w=="
							: mode === "base64"
								? "YR=="
								: mode === "chunk"
									? btoa("a".repeat(32769))
									: mode === "trailing"
										? "YQ=="
										: "",
					eof:
						mode === "eof"
							? "true"
							: !["utf8", "empty", "base64", "chunk"].includes(mode),
				};
			return successful;
		});
		await expect(
			h.runtime.archiveInput?.readDocument("archive"),
		).rejects.toThrow();
		expect(h.call.mock.calls.at(-1)?.[0]).toBe("archive.input.cancel");
	}
});
test("archive input aborts before chooser without native calls", async () => {
	const h = archiveHarness(async () => successful);
	const abort = new AbortController();
	abort.abort();
	await expect(
		h.runtime.archiveInput?.readDocument("content", abort.signal),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(h.call).not.toHaveBeenCalled();
});
test("archive input aborts pending chooser promptly and cancels late capability", async () => {
	let resolve!: (reply: Reply) => void;
	const h = archiveHarness(async (op) =>
		op === "archive.input.pick"
			? new Promise<Reply>((r) => {
					resolve = r;
				})
			: successful,
	);
	const abort = new AbortController();
	const reading = h.runtime.archiveInput?.readDocument("archive", abort.signal);
	await expect(h.runtime.archiveInput?.readDocument("content")).rejects.toThrow(
		"busy",
	);
	abort.abort();
	await expect(reading).rejects.toMatchObject({ name: "AbortError" });
	expect(h.call).toHaveBeenCalledWith("archive.input.cancelPending", {});
	resolve(inputReady);
	await new Promise((r) => setTimeout(r, 0));
	expect(h.call).toHaveBeenCalledWith("archive.input.cancel", {
		transferId: "input-A",
	});
	expect(h.call.mock.calls.some(([op]) => op === "archive.input.read")).toBe(
		false,
	);
});
test("archive input aborts between chunks without exposing partial text", async () => {
	const abort = new AbortController();
	const h = archiveHarness(async (op) => {
		if (op === "archive.input.pick") return { ...inputReady, bytes: 1 };
		if (op === "archive.input.read") {
			abort.abort();
			return { ok: true, data: "YQ==", eof: false };
		}
		return successful;
	});
	await expect(
		h.runtime.archiveInput?.readDocument("content", abort.signal),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(
		h.call.mock.calls.filter(([op]) => op === "archive.input.read"),
	).toHaveLength(1);
	expect(h.call).toHaveBeenCalledWith("archive.input.cancel", {
		transferId: "input-A",
	});
});
test("archive input retirement never cancels replacement owner", async () => {
	let resolve!: (reply: Reply) => void;
	const h = archiveHarness(
		async () =>
			new Promise<Reply>((r) => {
				resolve = r;
			}),
	);
	const reading = h.runtime.archiveInput?.readDocument("content");
	h.retire();
	resolve(inputReady);
	await expect(reading).rejects.toThrow("retired");
	expect(h.call).toHaveBeenCalledTimes(1);
});

test("archive chooser cancellation returns null and releases the pending chooser", async () => {
	const h = archiveHarness(async (op) => {
		if (op === "archive.input.pick") throw new NativeError("cancelled");
		return successful;
	});
	expect(await h.runtime.archiveInput?.readDocument("content")).toBeNull();
	expect(await h.runtime.archiveInput?.readDocument("archive")).toBeNull();
	expect(
		h.call.mock.calls.filter(([op]) => op === "archive.input.pick"),
	).toHaveLength(2);
	expect(
		h.call.mock.calls.filter(([op]) => op === "archive.input.cancelPending"),
	).toHaveLength(2);
	expect(h.call.mock.calls.some(([op]) => op === "archive.input.read")).toBe(
		false,
	);
});

test("archive input returns a frozen named empty document rather than chooser cancellation", async () => {
	const h = archiveHarness(async (op) => {
		if (op === "archive.input.pick")
			return { ...inputReady, name: "empty.json" };
		if (op === "archive.input.read") return { ok: true, data: "", eof: true };
		return successful;
	});
	const picked = await h.runtime.archiveInput?.readDocument("content");
	expect(picked).toEqual({ text: "", name: "empty.json" });
	expect(Object.isFrozen(picked)).toBe(true);
	expect(h.call.mock.calls.at(-1)).toEqual([
		"archive.input.cancel",
		{ transferId: "input-A" },
	]);
});

test.each([
	new NativeError("picker-timeout"),
	new NativeError("invalid-message"),
	Object.assign(new Error("cancelled"), { code: "cancelled" }),
])("archive chooser does not convert other errors into cancellation: %s", async (error) => {
	const h = archiveHarness(async (op) => {
		if (op === "archive.input.pick") throw error;
		return successful;
	});
	await expect(h.runtime.archiveInput?.readDocument("archive")).rejects.toBe(
		error,
	);
	expect(h.call.mock.calls.at(-1)).toEqual(["archive.input.cancelPending", {}]);
});

test("archive input does not convert a read-phase cancellation into chooser cancellation", async () => {
	const h = archiveHarness(async (op) => {
		if (op === "archive.input.pick") return inputReady;
		if (op === "archive.input.read") throw new NativeError("cancelled");
		return successful;
	});
	await expect(
		h.runtime.archiveInput?.readDocument("content"),
	).rejects.toMatchObject({ code: "cancelled" });
	expect(h.call.mock.calls.at(-1)).toEqual([
		"archive.input.cancel",
		{ transferId: "input-A" },
	]);
});

test("archive input retirement refuses a late cancelled chooser without replacement cleanup", async () => {
	let reject!: (error: unknown) => void;
	const h = archiveHarness(async (op) =>
		op === "archive.input.pick"
			? new Promise<Reply>((_, fail) => {
					reject = fail;
				})
			: successful,
	);
	const reading = h.runtime.archiveInput?.readDocument("archive");
	h.retire();
	reject(new NativeError("cancelled"));
	await expect(reading).rejects.toThrow("retired");
	expect(h.call).toHaveBeenCalledTimes(1);
});

test("archive input abort does not become null when the pending chooser reports cancelled", async () => {
	let reject!: (error: unknown) => void;
	const h = archiveHarness(async (op) =>
		op === "archive.input.pick"
			? new Promise<Reply>((_, fail) => {
					reject = fail;
				})
			: successful,
	);
	const abort = new AbortController();
	const reading = h.runtime.archiveInput?.readDocument("archive", abort.signal);
	abort.abort();
	reject(new NativeError("cancelled"));
	await expect(reading).rejects.toMatchObject({ name: "AbortError" });
	expect(h.call.mock.calls.some(([op]) => op === "archive.input.read")).toBe(
		false,
	);
});

test("save picker cancellation is typed, releases the chooser, and allows retry", async () => {
	let cancel = true;
	const h = harness(async (op) => {
		if (op === "save.pick") {
			if (cancel) throw new NativeError("cancelled");
			return { ok: true, saveId: "save-A" };
		}
		return successful;
	});
	await expect(h.runtime.pickFile("content.json")).rejects.toBeInstanceOf(
		FilePickerCancelledError,
	);
	cancel = false;
	await expect(h.runtime.pickFile("content.json")).resolves.toBeDefined();
});
test.each([
	new NativeError("picker-timeout"),
	Object.assign(new Error("cancelled"), { code: "cancelled" }),
])("save picker preserves non-cancellation errors %#", async (error) => {
	const h = harness(async (op) => {
		if (op === "save.pick") throw error;
		return successful;
	});
	await expect(h.runtime.pickFile("content.json")).rejects.toBe(error);
});
test.each([
	"abort",
	"retire",
])("save picker does not normalize cancellation after %s", async (kind) => {
	let reject!: (error: unknown) => void;
	const h = harness(async (op) =>
		op === "save.pick"
			? new Promise<Reply>((_resolve, fail) => {
					reject = fail;
				})
			: successful,
	);
	const abort = new AbortController();
	const picking = h.runtime.pickFile("content.json", abort.signal);
	if (kind === "abort") abort.abort();
	else h.retire();
	reject(new NativeError("cancelled"));
	await expect(picking).rejects.not.toBeInstanceOf(FilePickerCancelledError);
});
test("save writer cancellation remains a write error", async () => {
	const error = new NativeError("cancelled");
	const h = harness(async (op) => {
		if (op === "save.pick") return { ok: true, saveId: "save-A" };
		if (op === "save.write") throw error;
		return successful;
	});
	const destination = await h.runtime.pickFile("content.json");
	const writer = await destination.createWritable();
	await expect(writer.write(new Uint8Array([1]))).rejects.toBe(error);
});
