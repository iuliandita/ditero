import { expect, test } from "@playwright/test";

// Exercise real OPFS and browser streams; unit fakes cannot prove File snapshot or Web Lock lifetime.
test("large attachment download verifies ciphertext before bounded file writes", async ({
	page,
}) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const downloadPath = "/src/web/lib/e2e/download.ts";
		const streamPath = "/src/domain/e2e/stream.ts";
		const envelopePath = "/src/domain/e2e/envelope.ts";
		const wirePath = "/src/domain/e2e/wire.ts";
		const { saveAttachmentToFile } = (await import(
			downloadPath
		)) as typeof import("../../src/web/lib/e2e/download.ts");
		const { encryptStream, encryptedStreamLength } = (await import(
			streamPath
		)) as typeof import("../../src/domain/e2e/stream.ts");
		const { aad, encryptWrapped } = (await import(
			envelopePath
		)) as typeof import("../../src/domain/e2e/envelope.ts");
		const { encodeWrapped } = (await import(
			wirePath
		)) as typeof import("../../src/domain/e2e/wire.ts");
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const dek = crypto.getRandomValues(new Uint8Array(32));
		const size = 70 * 1024 * 1024 + 7;
		let produced = 0;
		async function* plaintext() {
			while (produced < size) {
				const chunk = new Uint8Array(
					Math.min(1024 * 1024, size - produced),
				).fill(42);
				produced += chunk.length;
				yield chunk;
			}
		}
		const encrypted = encryptStream(plaintext(), dek, "content")[
			Symbol.asyncIterator
		]();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = await encrypted.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
		});
		const row = {
			id: "browser-download",
			workspaceId: "workspace",
			keyVersion: 1,
			filenameCiphertext: encodeWrapped(
				await encryptWrapped(
					new TextEncoder().encode("large.bin"),
					dek,
					aad.metadata("browser-download", "filename"),
				),
			),
			contentTypeCiphertext: encodeWrapped(
				await encryptWrapped(
					new TextEncoder().encode("application/octet-stream"),
					dek,
					aad.metadata("browser-download", "contentType"),
				),
			),
			dekWrapped: encodeWrapped(
				await encryptWrapped(
					dek,
					wdk,
					aad.dek("workspace", 1, "browser-download"),
				),
			),
		};
		let written = 0;
		let largestWrite = 0;
		let closed = false;
		let sourceCompleteAtOpen = false;
		const destination = {
			async createWritable() {
				sourceCompleteAtOpen = produced === size;
				return {
					async write(chunk: Uint8Array) {
						if (chunk.some((byte) => byte !== 42))
							throw new Error("wrong plaintext");
						written += chunk.length;
						largestWrite = Math.max(largestWrite, chunk.length);
					},
					async close() {
						closed = true;
					},
					async abort() {
						throw new Error("unexpected abort");
					},
				} as unknown as FileSystemWritableFileStream;
			},
		};
		await saveAttachmentToFile(row, wdk, destination, {
			fetcher: async () =>
				new Response(body, {
					headers: { "content-length": String(encryptedStreamLength(size)) },
				}),
		});
		const root = await navigator.storage.getDirectory();
		const remaining: string[] = [];
		for await (const name of root.keys())
			if (name.startsWith("ditero-ciphertext-v1-")) remaining.push(name);
		return { written, largestWrite, closed, sourceCompleteAtOpen, remaining };
	});
	expect(result).toEqual({
		written: 70 * 1024 * 1024 + 7,
		largestWrite: 1024 * 1024,
		closed: true,
		sourceCompleteAtOpen: true,
		remaining: [],
	});
});

test("staging recovery preserves a live tab and reclaims its stage after termination", async ({
	page,
	context,
}) => {
	await page.goto("/");
	await page.evaluate(async () => {
		const path = "/src/web/lib/e2e/ciphertext-staging.ts";
		const { withCiphertextStage } = (await import(
			path
		)) as typeof import("../../src/web/lib/e2e/ciphertext-staging.ts");
		await new Promise<void>((ready) => {
			void withCiphertextStage(async (handle) => {
				const writer = await handle.createWritable();
				await writer.write(new Uint8Array([1, 2, 3]));
				await writer.close();
				ready();
				await new Promise<void>(() => undefined);
			});
		});
	});
	const other = await context.newPage();
	await other.goto("/");
	const recover = async () =>
		await other.evaluate(async () => {
			const path = "/src/web/lib/e2e/ciphertext-staging.ts";
			const { recoverCiphertextStages } = (await import(
				path
			)) as typeof import("../../src/web/lib/e2e/ciphertext-staging.ts");
			await recoverCiphertextStages();
			const names: string[] = [];
			for await (const name of (await navigator.storage.getDirectory()).keys())
				if (name.startsWith("ditero-ciphertext-v1-")) names.push(name);
			return names.length;
		});
	expect(await recover()).toBe(1);
	await page.close();
	await expect.poll(recover).toBe(0);
});
