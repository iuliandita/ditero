export class BlobNotFoundError extends Error {
	constructor(readonly key: string) {
		super(`blob not found: ${key}`);
		this.name = "BlobNotFoundError";
	}
}

export function storageErrorCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[A-Z0-9_]+$/.test(error.code)
	)
		return error.code;
	if (error instanceof AggregateError) {
		return error.errors.map(storageErrorCode).join(", ");
	}
	return "UNKNOWN";
}

export type BlobStore = {
	put(
		key: string,
		body: AsyncIterable<Uint8Array>,
	): Promise<{ bytes: number; sha256: string }>;
	get(key: string): Promise<AsyncIterable<Uint8Array>>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
};
