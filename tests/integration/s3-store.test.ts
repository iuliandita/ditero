import { createHash, randomUUID } from "node:crypto";
import { S3Client } from "bun";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BlobNotFoundError } from "../../src/server/storage/blob-store.ts";
import { S3BlobStore } from "../../src/server/storage/s3-store.ts";

const PART_SIZE = 5 * 1024 * 1024;
const encoder = new TextEncoder();

async function* chunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield value;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

describe("S3BlobStore", () => {
	let store: S3BlobStore;
	let client: S3Client;
	let keys: string[];

	beforeAll(() => {
		const options = {
			accessKeyId: required("S3_ACCESS_KEY_ID"),
			secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
			bucket: required("S3_BUCKET"),
			endpoint: required("S3_ENDPOINT"),
			region: required("S3_REGION"),
			partSize: PART_SIZE,
			queueSize: 2,
		};
		store = new S3BlobStore(options);
		client = new S3Client(options);
	});

	afterEach(async () => {
		await Promise.all(keys.map((key) => store.delete(key)));
	});

	function key(label: string): string {
		const value = `integration/${label}-${randomUUID()}`;
		keys.push(value);
		return value;
	}

	beforeEach(() => {
		keys = [];
	});

	it("round-trips a stream and reports observed bytes and hash", async () => {
		const objectKey = key("roundtrip");
		const first = encoder.encode("cipher");
		const second = encoder.encode("text");

		expect(await store.exists(objectKey)).toBe(false);
		const result = await store.put(objectKey, chunks(first, second));

		expect(result).toEqual({
			bytes: 10,
			sha256: createHash("sha256").update(first).update(second).digest("hex"),
		});
		expect(await collect(await store.get(objectKey))).toEqual(
			encoder.encode("ciphertext"),
		);
	});

	it("deletes a stored object", async () => {
		const objectKey = key("delete");
		await store.put(objectKey, chunks(encoder.encode("content")));
		expect(await store.exists(objectKey)).toBe(true);

		await store.delete(objectKey);

		expect(await store.exists(objectKey)).toBe(false);
	});

	it("leaves no final object when the input fails mid-stream", async () => {
		const objectKey = key("failed");
		async function* failing(): AsyncIterable<Uint8Array> {
			yield new Uint8Array(PART_SIZE).fill(7);
			throw new Error("stream failed");
		}

		await expect(store.put(objectKey, failing())).rejects.toThrow(
			"stream failed",
		);
		expect(await store.exists(objectKey)).toBe(false);
		expect(
			(await client.list({ prefix: `${objectKey}.upload-` })).contents ?? [],
		).toHaveLength(0);
	}, 30_000);

	it("throws a typed error for a missing object", async () => {
		await expect(store.get(key("missing"))).rejects.toBeInstanceOf(
			BlobNotFoundError,
		);
	});

	it("reassembles an upload larger than one multipart part", async () => {
		const objectKey = key("multipart");
		const payload = new Uint8Array(PART_SIZE + 257);
		for (let index = 0; index < payload.length; index += 1) {
			payload[index] = index % 251;
		}

		const result = await store.put(
			objectKey,
			chunks(payload.subarray(0, PART_SIZE), payload.subarray(PART_SIZE)),
		);

		expect(result).toEqual({
			bytes: payload.byteLength,
			sha256: createHash("sha256").update(payload).digest("hex"),
		});
		expect(await collect(await store.get(objectKey))).toEqual(payload);
	}, 30_000);
});
