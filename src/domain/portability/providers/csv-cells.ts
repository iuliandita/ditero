import {
	checkProviderText,
	PROVIDER_MAX_FIELD_BYTES,
	PROVIDER_MAX_ROWS,
	ProviderImportError,
} from "./common.ts";

function fail(
	code: ConstructorParameters<typeof ProviderImportError>[0],
	row?: number,
): never {
	throw new ProviderImportError(code, row);
}

export function parseProviderCsvCells(
	text: string,
	checkpoint: () => void,
	maxColumns: number,
	// Lazy quotes and lone CR record ends, for provider exports with unescaped delimiters.
	lenient = false,
): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let state: "start" | "plain" | "quoted" | "closed" = "start";
	let ended = true;
	const cell = () => {
		checkProviderText(field, PROVIDER_MAX_FIELD_BYTES, rows.length + 1);
		row.push(field);
		if (row.length > maxColumns) fail("invalid-csv", rows.length + 1);
		field = "";
		state = "start";
	};
	const record = () => {
		cell();
		rows.push(row);
		if (rows.length > PROVIDER_MAX_ROWS + 1) fail("row-limit");
		row = [];
		ended = true;
	};
	for (let i = 0; i < text.length; i++) {
		if (i % 512 === 0) checkpoint();
		const character = text[i];
		ended = false;
		if (state === "quoted") {
			if (character === '"') {
				const next = text[i + 1];
				if (next === '"') {
					field += '"';
					i++;
				} else if (
					lenient &&
					next !== undefined &&
					next !== "," &&
					next !== "\n" &&
					next !== "\r"
				)
					field += '"';
				else state = "closed";
			} else field += character;
		} else if (character === ",") cell();
		else if (character === "\n" || character === "\r") {
			if (character === "\r" && text[i + 1] !== "\n" && !lenient)
				fail("invalid-csv", rows.length + 1);
			if (character === "\r" && text[i + 1] === "\n") i++;
			record();
		} else if (character === '"' && state === "start") state = "quoted";
		else if (state === "closed" || (character === '"' && !lenient))
			fail("invalid-csv", rows.length + 1);
		else {
			state = "plain";
			field += character;
		}
		if (field.length > PROVIDER_MAX_FIELD_BYTES)
			fail("field-limit", rows.length + 1);
	}
	if (state === "quoted") fail("invalid-csv", rows.length + 1);
	if (!ended) record();
	checkpoint();
	return rows;
}
