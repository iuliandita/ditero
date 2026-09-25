import {
	parseBoundedPortableJson,
	validatePortableExportV1Value,
} from "./validate.ts";

export class UnsupportedImportVersionError extends Error {
	readonly code = "unsupported-import-version";

	constructor() {
		super("History archives cannot be imported yet");
	}
}

export function parseImportDocument(input: string) {
	const value = parseBoundedPortableJson(input);
	if (
		value !== null &&
		typeof value === "object" &&
		"format" in value &&
		value.format === "ditero" &&
		"schemaVersion" in value &&
		value.schemaVersion === 2
	)
		throw new UnsupportedImportVersionError();
	return validatePortableExportV1Value(value);
}
