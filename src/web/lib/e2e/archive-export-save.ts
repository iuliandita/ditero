import { ATTACHMENT_ARCHIVE_LIMITS } from "../../../domain/portability/attachment-archive.ts";
import type { AttachmentFileWriter } from "./download.ts";
import type { AttachmentRuntime } from "./runtime.ts";

export async function saveNativeArchiveDocument(
	runtime: AttachmentRuntime,
	file: { filename: string; json: string },
	signal: AbortSignal,
	assertCurrent: () => void,
): Promise<void> {
	const check = () => {
		signal.throwIfAborted();
		assertCurrent();
	};
	check();
	if (!runtime.archiveExport) throw new Error("native-unavailable");
	if (file.json.length > ATTACHMENT_ARCHIVE_LIMITS.serializedBytes)
		throw new Error("content-export-limit");
	const bytes = new TextEncoder().encode(file.json);
	if (bytes.byteLength > ATTACHMENT_ARCHIVE_LIMITS.serializedBytes)
		throw new Error("content-export-limit");
	const destination = await runtime.pickFile(file.filename, signal);
	let writer: AttachmentFileWriter | undefined;
	let complete = false;
	let writerAborted = false;
	let destinationCancelled = false;
	const cancel = async () => {
		const pending: Promise<void>[] = [];
		if (writer && !writerAborted) {
			writerAborted = true;
			pending.push(writer.abort().catch(() => undefined));
		}
		if (!destinationCancelled) {
			destinationCancelled = true;
			pending.push(
				destination.cancel?.().catch(() => undefined) ?? Promise.resolve(),
			);
		}
		await Promise.all(pending);
	};
	const onAbort = () => {
		void cancel();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		check();
		writer = await destination.createWritable();
		for (let offset = 0; offset < bytes.length; offset += 32768) {
			check();
			await writer.write(bytes.subarray(offset, offset + 32768));
		}
		check();
		await writer.close();
		check();
		complete = true;
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (!complete) await cancel();
	}
}
