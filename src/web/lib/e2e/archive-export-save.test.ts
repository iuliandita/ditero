import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_ARCHIVE_LIMITS } from "../../../domain/portability/attachment-archive.ts";
import { saveNativeArchiveDocument } from "./archive-export-save.ts";
import type { AttachmentRuntime } from "./runtime.ts";

function fixture() {
	const chunks: Uint8Array[] = [];
	const writer = {
		write: vi.fn(async (bytes: Uint8Array) => {
			chunks.push(bytes.slice());
		}),
		close: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	};
	const destination = {
		createWritable: vi.fn(async () => writer),
		cancel: vi.fn(async () => {}),
	};
	const runtime: AttachmentRuntime = {
		archiveExport: { readContent: async () => "{}" },
		fetcher: async () => {
			throw new Error("unexpected fetch");
		},
		pickFile: vi.fn(async () => destination),
		withStage: async () => {
			throw new Error("unexpected stage");
		},
	};
	return {
		runtime,
		chunks,
		writer,
		destination,
		abort: new AbortController(),
		current: vi.fn(),
	};
}
describe("native paired archive save", () => {
	it("writes exact UTF-8 bytes in bounded chunks and waits for confirmed close", async () => {
		const f = fixture();
		let finish: (() => void) | undefined;
		f.writer.close.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const json = JSON.stringify({ value: "é".repeat(40000) });
		let saved = false;
		const operation = saveNativeArchiveDocument(
			f.runtime,
			{ filename: "content.json", json },
			f.abort.signal,
			f.current,
		).then(() => {
			saved = true;
		});
		await vi.waitFor(() => expect(f.writer.close).toHaveBeenCalledOnce());
		expect(saved).toBe(false);
		finish?.();
		await operation;
		expect(saved).toBe(true);
		expect(f.chunks.every((chunk) => chunk.length <= 32768)).toBe(true);
		expect(
			new TextDecoder().decode(
				new Uint8Array(f.chunks.flatMap((chunk) => [...chunk])),
			),
		).toBe(json);
		expect(f.destination.cancel).not.toHaveBeenCalled();
	});
	it("refuses UTF-8 byte overflow before opening a destination", async () => {
		const f = fixture();
		await expect(
			saveNativeArchiveDocument(
				f.runtime,
				{
					filename: "files.json",
					json: "é".repeat(ATTACHMENT_ARCHIVE_LIMITS.serializedBytes / 2 + 1),
				},
				f.abort.signal,
				f.current,
			),
		).rejects.toThrow("content-export-limit");
		expect(f.runtime.pickFile).not.toHaveBeenCalled();
	});
	it.each([
		"abort",
		"retire",
		"close-failure",
	])("cancels owned destination on %s without reporting success", async (kind) => {
		const f = fixture();
		if (kind === "abort")
			f.writer.write.mockImplementation(async () => {
				f.abort.abort();
			});
		if (kind === "retire")
			f.writer.write.mockImplementation(async () => {
				f.current.mockImplementation(() => {
					throw new Error("retired");
				});
			});
		if (kind === "close-failure")
			f.writer.close.mockRejectedValue(new Error("save failed"));
		await expect(
			saveNativeArchiveDocument(
				f.runtime,
				{ filename: "files.json", json: "{}" },
				f.abort.signal,
				f.current,
			),
		).rejects.toBeDefined();
		expect(f.writer.abort).toHaveBeenCalledOnce();
		expect(f.destination.cancel).toHaveBeenCalledOnce();
	});
	it("cancels a picked destination if ownership changes before opening", async () => {
		const f = fixture();
		vi.mocked(f.runtime.pickFile).mockImplementation(async () => {
			f.current.mockImplementation(() => {
				throw new Error("retired");
			});
			return f.destination;
		});
		await expect(
			saveNativeArchiveDocument(
				f.runtime,
				{ filename: "files.json", json: "{}" },
				f.abort.signal,
				f.current,
			),
		).rejects.toThrow("retired");
		expect(f.destination.createWritable).not.toHaveBeenCalled();
		expect(f.destination.cancel).toHaveBeenCalledOnce();
	});
});
