import { createHash, randomUUID } from "node:crypto";
import { S3Client, type S3Options } from "bun";
import { BlobNotFoundError, type BlobStore } from "./blob-store.ts";

export type S3BlobStoreOptions = S3Options & { bucket: string };

function asError(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error("blob stream failed", { cause: error });
}

export class S3BlobStore implements BlobStore {
	readonly #client: S3Client;

	constructor(options: S3BlobStoreOptions) {
		this.#client = new S3Client({ virtualHostedStyle: false, ...options });
	}

	async put(
		key: string,
		body: AsyncIterable<Uint8Array>,
	): Promise<{ bytes: number; sha256: string }> {
		const temporaryKey = `${key}.upload-${randomUUID()}`;
		const writer = this.#client.file(temporaryKey).writer({
			type: "application/octet-stream",
		});
		const hash = createHash("sha256");
		let bytes = 0;

		try {
			try {
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
					await writer.write(chunk);
				}
			} catch (error) {
				const reason = asError(error);
				try {
					await writer.end(reason);
				} catch (abortError) {
					if (abortError !== error && abortError !== reason) {
						throw new AggregateError(
							[error, abortError],
							"blob write and multipart abort both failed",
						);
					}
				}
				throw error;
			}

			await writer.end();
			await this.#client.write(key, this.#client.file(temporaryKey), {
				type: "application/octet-stream",
			});
		} catch (error) {
			try {
				await this.#client.delete(temporaryKey);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"blob write and temporary-object cleanup both failed",
				);
			}
			throw error;
		}

		await this.#client.delete(temporaryKey);
		return { bytes, sha256: hash.digest("hex") };
	}

	async get(key: string): Promise<AsyncIterable<Uint8Array>> {
		if (!(await this.#client.exists(key))) throw new BlobNotFoundError(key);
		return this.#client.file(key).stream();
	}

	async delete(key: string): Promise<void> {
		await this.#client.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return await this.#client.exists(key);
	}
}
