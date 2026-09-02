import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "./fs-store.ts";

const encoder = new TextEncoder();

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield encoder.encode(value);
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const values: number[] = [];
	for await (const chunk of body) values.push(...chunk);
	return Uint8Array.from(values);
}

describe("FsBlobStore", () => {
	let root: string;
	let store: FsBlobStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ditero-fs-store-"));
		store = new FsBlobStore(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("round-trips a stream and returns its observed size and hash", async () => {
		const key = "ws_1/a4/att_1";
		expect(await store.exists(key)).toBe(false);

		const result = await store.put(key, chunks("a", "b", "c"));

		expect(result).toEqual({
			bytes: 3,
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		});
		expect(await store.exists(key)).toBe(true);
		expect(new TextDecoder().decode(await collect(await store.get(key)))).toBe(
			"abc",
		);
	});

	it("deletes a stored blob", async () => {
		const key = "ws_1/a4/att_1";
		await store.put(key, chunks("content"));

		await store.delete(key);

		expect(await store.exists(key)).toBe(false);
	});

	it("leaves no final or temporary file when the input fails", async () => {
		const key = "ws_1/a4/att_1";
		async function* failing(): AsyncIterable<Uint8Array> {
			yield encoder.encode("partial");
			throw new Error("stream failed");
		}

		await expect(store.put(key, failing())).rejects.toThrow("stream failed");
		expect(await store.exists(key)).toBe(false);
		expect(await readdir(join(root, dirname(key)))).toEqual([]);
	});

	it("keeps the final key invisible until the stream completes", async () => {
		const key = "ws_1/a4/att_1";
		const firstChunk = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		async function* paused(): AsyncIterable<Uint8Array> {
			yield encoder.encode("first");
			firstChunk.resolve();
			await release.promise;
			yield encoder.encode("second");
		}

		const writing = store.put(key, paused());
		await firstChunk.promise;
		const visibleWhileWriting = await store.exists(key);
		release.resolve();
		await writing;

		expect(visibleWhileWriting).toBe(false);
		expect(await store.exists(key)).toBe(true);
	});

	it("rejects traversal before touching the filesystem", async () => {
		const outside = join(root, "..", `ditero-fs-escape-${crypto.randomUUID()}`);
		const traversal = `../${basename(outside)}`;

		await expect(store.put(traversal, chunks("escape"))).rejects.toThrow(
			/invalid blob key/,
		);
		await expect(store.exists(traversal)).rejects.toThrow(/invalid blob key/);
		await expect(stat(outside)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("hashes the bytes supplied by views, not their backing buffers", async () => {
		const backing = encoder.encode("discardpayloaddiscard");
		const payload = backing.subarray(7, 14);
		const result = await store.put(
			"ws_1/a4/att_1",
			(async function* () {
				yield payload;
			})(),
		);

		expect(result).toEqual({
			bytes: payload.byteLength,
			sha256: createHash("sha256").update(payload).digest("hex"),
		});
	});

	it("writes the longest attachment segment accepted by storageKeyFor", async () => {
		const key = `ws_1/a4/${"a".repeat(245)}`;

		await store.put(key, chunks("content"));

		expect(await store.exists(key)).toBe(true);
	});
});
