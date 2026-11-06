import type { parseImportDocument } from "../../domain/portability/import-document.ts";
import type { prepareProviderImportRequest } from "../../domain/portability/providers/input.ts";

export class ImportParsingError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}
export type ImportParseJob =
	| { kind: "envelope"; text: string }
	| { kind: "document"; text: string }
	| { kind: "provider"; value: unknown; exportedAt: string };
export type ImportParseResult<J extends ImportParseJob> = J extends {
	kind: "document";
}
	? ReturnType<typeof parseImportDocument>
	: J extends { kind: "provider" }
		? Awaited<ReturnType<typeof prepareProviderImportRequest>>
		: unknown;
export type ImportParseReply<J extends ImportParseJob> =
	| { ok: true; value: ImportParseResult<J> }
	| { ok: false; code: string; status: number; detail?: string };
