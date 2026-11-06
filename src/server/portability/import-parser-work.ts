import {
	parseImportDocument,
	UnsupportedImportVersionError,
} from "../../domain/portability/import-document.ts";
import { ProviderImportError } from "../../domain/portability/providers/common.ts";
import {
	PROVIDER_REQUEST_MAX_BYTES,
	ProviderInputError,
	prepareProviderImportRequest,
} from "../../domain/portability/providers/input.ts";
import { PortableExportValidationError } from "../../domain/portability/validate.ts";
import {
	type ImportParseJob,
	type ImportParseReply,
	ImportParsingError,
} from "./import-parser-protocol.ts";

// Identify provider envelopes before allocating the parsed JSON tree.
function providerEnvelope(text: string, checkpoint: () => void): boolean {
	let depth = 0;
	for (let index = 0; index < text.length; index++) {
		if (index % 8192 === 0) checkpoint();
		const character = text[index];
		if (character === "{" || character === "[") depth++;
		else if (character === "}" || character === "]") depth--;
		else if (character === '"') {
			const start = index++;
			for (; index < text.length; index++) {
				if (index % 8192 === 0) checkpoint();
				if (text[index] === "\\") index++;
				else if (text[index] === '"') break;
			}
			if (depth !== 1 || index - start > 32) continue;
			let next = index + 1;
			while (/\s/.test(text[next] ?? "") && next < text.length) next++;
			if (
				text[next] === ":" &&
				JSON.parse(text.slice(start, index + 1)) === "input"
			)
				return true;
		}
	}
	return false;
}

export async function performImportParse<J extends ImportParseJob>(
	job: J,
	budget: number,
): Promise<ImportParseReply<J>> {
	const deadline = performance.now() + budget;
	const checkpoint = () => {
		if (performance.now() >= deadline)
			throw new ImportParsingError("timeout", 503);
	};
	try {
		let value: unknown;
		if (job.kind === "envelope") {
			try {
				if (
					Buffer.byteLength(job.text) > PROVIDER_REQUEST_MAX_BYTES &&
					providerEnvelope(job.text, checkpoint)
				)
					throw new ImportParsingError("request-limit", 413);
				value = JSON.parse(job.text);
			} catch (error) {
				if (error instanceof ImportParsingError) throw error;
				throw new ImportParsingError("invalid-request", 400);
			}
		} else if (job.kind === "document")
			value = parseImportDocument(job.text, {
				historyPreview: true,
				checkpoint,
			});
		else
			value = await prepareProviderImportRequest(job.value, {
				exportedAt: job.exportedAt,
				deadline,
			});
		checkpoint();
		return { ok: true, value } as ImportParseReply<J>;
	} catch (error) {
		let code = "import-plan-failed";
		let status = 500;
		if (error instanceof ImportParsingError) {
			code = error.code;
			status = error.status;
		} else if (error instanceof UnsupportedImportVersionError) {
			code = error.code;
			status = 400;
		} else if (
			error instanceof PortableExportValidationError ||
			error instanceof ProviderInputError ||
			error instanceof ProviderImportError
		) {
			code = error.code;
			status = code.endsWith("-limit")
				? 413
				: code === "timeout"
					? 503
					: code === "cancelled"
						? 408
						: 400;
		}
		return {
			ok: false,
			code,
			status,
			detail:
				status === 500
					? String(error instanceof Error ? error.stack : error)
					: undefined,
		};
	}
}
