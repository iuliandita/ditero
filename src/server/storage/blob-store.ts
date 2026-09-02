export type BlobStore = {
	put(
		key: string,
		body: AsyncIterable<Uint8Array>,
	): Promise<{ bytes: number; sha256: string }>;
	get(key: string): Promise<AsyncIterable<Uint8Array>>;
	delete(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
};
