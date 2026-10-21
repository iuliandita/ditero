import type { AttachmentFileWriter } from "./download.ts";
import type { E2eRuntime } from "./runtime.ts";

const DOWNLOAD_NAME = "ditero-recovery-code.txt";

export async function downloadRecoveryCode(
	display: string,
	runtime: E2eRuntime,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	if (runtime.attachments) {
		// Both hosts bind save.pick/write/finish to the captured account and page.
		const destination = await runtime.attachments.pickFile(
			DOWNLOAD_NAME,
			signal,
		);
		let writer: AttachmentFileWriter | undefined;
		try {
			signal.throwIfAborted();
			writer = await destination.createWritable();
			await writer.write(new TextEncoder().encode(display));
			signal.throwIfAborted();
			await writer.close();
		} catch (error) {
			await writer?.abort().catch(() => undefined);
			await destination.cancel?.().catch(() => undefined);
			throw error;
		}
		return;
	}
	const url = URL.createObjectURL(new Blob([display], { type: "text/plain" }));
	try {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = DOWNLOAD_NAME;
		anchor.click();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
}
