import type { PortableExportV1 } from "./v1.ts";
import type { PortableExportV2 } from "./v2.ts";
import {
	parseBoundedPortableJson,
	validatePortableExportV1Value,
} from "./validate.ts";
import { validatePortableExportV2Value } from "./validate-v2.ts";

export class UnsupportedImportVersionError extends Error {
	readonly code = "unsupported-import-version";

	constructor() {
		super("History archives cannot be imported yet");
	}
}

export function parseImportDocument(input: string): PortableExportV1;
export function parseImportDocument(
	input: string,
	options: { historyPreview: true },
): PortableExportV1 | PortableExportV2;
export function parseImportDocument(
	input: string,
	options?: { historyPreview: true },
) {
	const value = parseBoundedPortableJson(input);
	if (
		value !== null &&
		typeof value === "object" &&
		"format" in value &&
		value.format === "ditero" &&
		"schemaVersion" in value &&
		value.schemaVersion === 2
	) {
		if (options?.historyPreview) return validatePortableExportV2Value(value);
		throw new UnsupportedImportVersionError();
	}
	return validatePortableExportV1Value(value);
}

// Historical authors never pass through native principal/author mapping.
export function ordinaryArchiveContent(
	document: PortableExportV2,
): PortableExportV1 {
	const { completionEvents: _events, ...data } = document.data;
	return {
		format: document.format,
		schemaVersion: 1,
		exportedAt: document.exportedAt,
		sourceUserId: document.sourceUserId,
		boundaries: {
			...document.boundaries,
			taskHistory: "current-state-and-habit-logs",
		},
		data: { ...data, comments: [], templates: [] },
	};
}
