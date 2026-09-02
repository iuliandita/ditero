import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobStore } from "./blob-store.ts";

function invalidKey(key: string): Error {
	return new Error(`invalid blob key: ${JSON.stringify(key)}`);
}

function hasInvalidKeyCharacter(key: string): boolean {
	for (const character of key) {
		const code = character.charCodeAt(0);
		if (character === "\\" || code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

export class FsBlobStore implements BlobStore {
	readonly #root: string;

	constructor(root: string) {
		if (root.length === 0) throw new Error("blob store root must not be empty");
		this.#root = resolve(root);
	}

	#path(key: string): string {
		const segments = key.split("/");
		if (
			key.length === 0 ||
			isAbsolute(key) ||
			hasInvalidKeyCharacter(key) ||
			segments.some(
				(segment) => segment === "" || segment === "." || segment === "..",
			)
		) {
			throw invalidKey(key);
		}

		const path = resolve(this.#root, ...segments);
		if (!path.startsWith(`${this.#root}${sep}`)) throw invalidKey(key);
		return path;
	}

	async put(
		key: string,
		body: AsyncIterable<Uint8Array>,
	): Promise<{ bytes: number; sha256: string }> {
		const finalPath = this.#path(key);
		const parent = dirname(finalPath);
		const temporaryPath = resolve(parent, `.${randomUUID()}.tmp`);
		await mkdir(parent, { recursive: true });

		let bytes = 0;
		const hash = createHash("sha256");
		async function* observed(): AsyncIterable<Uint8Array> {
			for await (const chunk of body) {
				if (!(chunk instanceof Uint8Array)) {
					throw new Error("blob body must yield Uint8Array chunks");
				}
				const nextBytes = bytes + chunk.byteLength;
				if (!Number.isSafeInteger(nextBytes)) {
					throw new Error("blob exceeds the observable byte-count range");
				}
				bytes = nextBytes;
				hash.update(chunk);
				yield chunk;
			}
		}

		try {
			await pipeline(
				Readable.from(observed()),
				createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
			);
			await rename(temporaryPath, finalPath);
		} catch (error) {
			try {
				await rm(temporaryPath, { force: true });
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"blob write and temporary-file cleanup both failed",
				);
			}
			throw error;
		}

		return { bytes, sha256: hash.digest("hex") };
	}

	async get(key: string): Promise<AsyncIterable<Uint8Array>> {
		const path = this.#path(key);
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error(`blob is not a file: ${key}`);
		return createReadStream(path);
	}

	async delete(key: string): Promise<void> {
		await rm(this.#path(key), { force: true });
	}

	async exists(key: string): Promise<boolean> {
		try {
			return (await stat(this.#path(key))).isFile();
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return false;
			}
			throw error;
		}
	}
}
