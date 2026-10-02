import { randomId } from "../../../domain/random-id.ts";

// Older tabs do not hold locks: their unversioned stages cannot be safely swept.
const STAGE_PREFIX = "ditero-ciphertext-v1-";

function stagePrefix(storageScope?: string): string {
	if (storageScope === undefined) return STAGE_PREFIX;
	if (!storageScope.trim()) {
		throw new Error("ciphertext-staging: storage scope must be nonempty");
	}
	const encoded = encodeURIComponent(storageScope);
	return `ditero-ciphertext-scoped-v1-${encoded.length}-${encoded}-`;
}

export async function recoverCiphertextStages(
	storageScope?: string,
): Promise<void> {
	const prefix = stagePrefix(storageScope);
	if (
		typeof navigator === "undefined" ||
		!navigator.locks ||
		!navigator.storage?.getDirectory
	)
		return;
	const root = await navigator.storage.getDirectory();
	for await (const [name, handle] of root.entries()) {
		if (handle.kind !== "file" || !name.startsWith(prefix)) continue;
		await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
			if (!lock) return;
			try {
				await root.removeEntry(name);
			} catch (error) {
				if (!(error instanceof DOMException && error.name === "NotFoundError"))
					throw error;
			}
		});
	}
}

export async function withCiphertextStage<T>(
	use: (handle: FileSystemFileHandle) => Promise<T>,
	storageScope?: string,
): Promise<T> {
	const prefix = stagePrefix(storageScope);
	await recoverCiphertextStages(storageScope);
	const root = await navigator.storage.getDirectory();
	const name = `${prefix}${randomId()}`;
	// Acquire before creation; termination releases this lock even without finally.
	return await navigator.locks.request(name, async () => {
		try {
			return await use(await root.getFileHandle(name, { create: true }));
		} finally {
			await root.removeEntry(name).catch(() => undefined);
		}
	});
}
