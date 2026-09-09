import { randomId } from "../../../domain/random-id.ts";

// Older tabs do not hold locks: their unversioned stages cannot be safely swept.
const STAGE_PREFIX = "ditero-ciphertext-v1-";

export async function recoverCiphertextStages(): Promise<void> {
	if (
		typeof navigator === "undefined" ||
		!navigator.locks ||
		!navigator.storage?.getDirectory
	)
		return;
	const root = await navigator.storage.getDirectory();
	for await (const [name, handle] of root.entries()) {
		if (handle.kind !== "file" || !name.startsWith(STAGE_PREFIX)) continue;
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
): Promise<T> {
	await recoverCiphertextStages();
	const root = await navigator.storage.getDirectory();
	const name = `${STAGE_PREFIX}${randomId()}`;
	// Acquire before creation; termination releases this lock even without finally.
	return await navigator.locks.request(name, async () => {
		try {
			return await use(await root.getFileHandle(name, { create: true }));
		} finally {
			await root.removeEntry(name).catch(() => undefined);
		}
	});
}
