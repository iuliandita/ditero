const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function safeCharacters(value: string): string {
	return Array.from(value, (character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 32 ||
			(code >= 127 && code <= 159) ||
			code === 0x61c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
			? " "
			: character;
	}).join("");
}

export function safeText(value: string): string {
	return safeCharacters(value).replace(/\s+/gu, " ");
}

// Exact views opt in to keep structural spacing. Each other whitespace
// character becomes one space, so widths stay predictable and nothing collapses.
function exactText(value: string): string {
	return safeCharacters(value).replace(/[^\S ]/gu, " ");
}

function partText(part: TextPart): string {
	return part.preserveWhitespace ? exactText(part.text) : safeText(part.text);
}

function cellWidth(value: string): number {
	if (/^\p{Mark}+$/u.test(value)) return 0;
	if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value))
		return 2;
	const point = value.codePointAt(0) ?? 0;
	return point >= 0x1100 &&
		(point <= 0x115f ||
			point === 0x2329 ||
			point === 0x232a ||
			(point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
			(point >= 0xac00 && point <= 0xd7a3) ||
			(point >= 0xf900 && point <= 0xfaff) ||
			(point >= 0xfe10 && point <= 0xfe19) ||
			(point >= 0xfe30 && point <= 0xfe6f) ||
			(point >= 0xff00 && point <= 0xff60) ||
			(point >= 0xffe0 && point <= 0xffe6) ||
			point >= 0x20000)
		? 2
		: 1;
}

export function fitLine(
	value: string,
	columns: number,
	preserveWhitespace = false,
): string {
	const limit = Number.isFinite(columns)
		? Math.max(0, Math.min(1000, Math.floor(columns)))
		: 0;
	let result = "";
	let used = 0;
	for (const { segment } of segmenter.segment(
		preserveWhitespace ? exactText(value) : safeText(value),
	)) {
		const width = cellWidth(segment);
		if (used + width > limit) break;
		result += segment;
		used += width;
	}
	return result;
}

export function fitStyledLine(value: string, columns: number): string {
	const limit = Number.isFinite(columns)
		? Math.max(0, Math.min(1000, Math.floor(columns)))
		: 0;
	const escapeCharacter = String.fromCharCode(27);
	const sgr = new RegExp(`(${escapeCharacter}\\[[0-9;]*m)`, "u");
	const trusted = new RegExp(
		`^${escapeCharacter}\\[(?:0|[127]|3[0-7](?:;7)?(?:;[12])?)m$`,
		"u",
	);
	let result = "";
	let used = 0;
	let styled = false;
	outer: for (const part of value.split(sgr)) {
		if (part.startsWith(`${escapeCharacter}[`) && part.endsWith("m")) {
			if (trusted.test(part)) {
				result += part;
				styled = part !== `${escapeCharacter}[0m`;
			}
			continue;
		}
		for (const { segment } of segmenter.segment(safeCharacters(part))) {
			const width = cellWidth(segment);
			if (used + width > limit) break outer;
			result += segment;
			used += width;
		}
	}
	return result + (styled ? `${escapeCharacter}[0m` : "");
}

export interface Frame {
	title: string;
	status: string;
	footer: string;
	rows: readonly string[];
	selected: number;
	detail?: readonly string[];
	detailParts?: readonly (readonly TextPart[])[];
	detailScrollHint?: readonly string[];
	detailOffset?: number;
	color?: boolean;
	rowTones?: readonly Tone[];
	rowMetadata?: readonly string[];
	statusTone?: Tone;
	footerHints?: readonly string[];
	framed?: boolean;
	ascii?: boolean;
	context?: string;
	statusLine?: string;
	viewportTitle?: string;
	start?: boolean;
	startInfo?: readonly string[];
	rowParts?: readonly (readonly TextPart[])[];
	rowMetadataParts?: readonly (readonly TextPart[])[];
}

export interface TextPart {
	text: string;
	tone: Tone;
	fieldWidth?: number;
	bold?: boolean;
	dim?: boolean;
	// Keep runs of spaces. Only trusted exact payload structure sets this.
	preserveWhitespace?: boolean;
}

export type Tone =
	| "plain"
	| "brand"
	| "danger"
	| "warning"
	| "info"
	| "success"
	| "recurring";
const SGR: Record<Tone, string> = {
	plain: "",
	brand: "36",
	danger: "31",
	warning: "33",
	info: "34",
	success: "32",
	recurring: "35",
};

function decorate(
	value: string,
	tone: Tone,
	selected: boolean,
	enabled: boolean,
	weight?: "bold" | "dim",
): string {
	if (!enabled || !value) return value;
	const codes = [
		SGR[tone],
		selected ? "7" : "",
		weight === "bold" ? "1" : weight === "dim" ? "2" : "",
	]
		.filter(Boolean)
		.join(";");
	return codes ? `\x1b[${codes}m${value}\x1b[0m` : value;
}

function padLine(value: string, width: number, staticArt = false): string {
	const fitted = staticArt
		? fitStyledLine(value, width)
		: fitLine(value, width);
	const used = Array.from(segmenter.segment(fitted), ({ segment }) =>
		cellWidth(segment),
	).reduce((total, cells) => total + cells, 0);
	return fitted + " ".repeat(Math.max(0, width - used));
}

const ASCII_WORDMARK = [
	"     _ _ _                 ",
	"  __| (_) |_ ___ _ __ ___  ",
	" / _` | | __/ _ \\ '__/ _ \\ ",
	"| (_| | | ||  __/ | | (_) |",
	" \\__,_|_|\\__\\___|_|  \\___/ ",
];

function cells(value: string): number {
	return Array.from(segmenter.segment(safeText(value)), ({ segment }) =>
		cellWidth(segment),
	).reduce((total, width) => total + width, 0);
}

export function visibleCells(value: string): number {
	return Array.from(segmenter.segment(safeCharacters(value)), ({ segment }) =>
		cellWidth(segment),
	).reduce((total, width) => total + width, 0);
}

function clipped(
	value: string,
	width: number,
	ascii: boolean,
	preserve = false,
): string {
	const text = preserve ? exactText(value) : safeText(value);
	return fitLine(text, width, preserve) === text
		? text
		: width < 2
			? fitLine(text, width, preserve)
			: fitLine(text, width - 1, preserve) + (ascii ? "~" : "…");
}

function styledParts(
	parts: readonly TextPart[],
	width: number,
	enabled: boolean,
	selected: boolean,
	ascii: boolean,
	whole = false,
): string {
	const fitted: TextPart[] = [];
	let used = 0;
	for (const part of parts) {
		let text = partText(part);
		if (part.fieldWidth !== undefined) {
			const fieldWidth = Math.max(0, Math.min(width - used, part.fieldWidth));
			text = padLine(text, fieldWidth);
		}
		if (
			whole &&
			fitted.some((part) => part.text.trim().length > 0) &&
			used + visibleCells(text) > width
		)
			break;
		if (used + visibleCells(text) > width)
			text = clipped(text, width - used, ascii, part.preserveWhitespace);
		fitted.push({ ...part, text });
		used += visibleCells(text);
		if (used >= width) break;
	}
	const padding = " ".repeat(Math.max(0, width - used));
	return (
		fitted
			.map((part) =>
				decorate(
					part.text,
					selected ? "brand" : part.tone,
					selected,
					enabled,
					part.bold || (selected && part.tone !== "plain")
						? "bold"
						: !selected && part.dim
							? "dim"
							: undefined,
				),
			)
			.join("") +
		decorate(padding, selected ? "brand" : "plain", selected, enabled)
	);
}

function taskLines(frame: Frame, width: number, height: number): string[] {
	const enabled = frame.color === true;
	const ascii = frame.ascii === true;
	if (frame.detailParts || frame.detail) {
		const length = frame.detailParts?.length ?? frame.detail?.length ?? 0;
		const scroll =
			frame.detailScrollHint &&
			(length > height || (frame.detailOffset ?? 0) > 0);
		const available = Math.max(0, height - (scroll ? 1 : 0));
		const result = frame.detailParts
			? frame.detailParts
					.slice(0, available)
					.map((parts) => styledParts(parts, width, enabled, false, ascii))
			: (frame.detail ?? [])
					.slice(0, available)
					.map((line) => padLine(line, width));
		if (scroll) {
			while (result.length < available) result.push(" ".repeat(width));
			const hint =
				frame.detailScrollHint?.find(
					(text) => fitLine(text, width) === safeText(text),
				) ?? "";
			result.push(decorate(padLine(hint, width), "info", false, enabled));
		}
		return result;
	}
	const selected = Math.max(0, Math.min(frame.rows.length - 1, frame.selected));
	const artTones: readonly Tone[] = [
		"brand",
		"info",
		"recurring",
		"warning",
		"success",
	];
	const prefix =
		frame.start && width >= 95 && height >= 24
			? Array.from(
					{
						length: Math.max(
							ASCII_WORDMARK.length,
							frame.startInfo?.length ?? 0,
						),
					},
					(_, index) => {
						const art = padLine(ASCII_WORDMARK[index] ?? "", 31, true);
						const info = safeText(frame.startInfo?.[index] ?? "");
						const split =
							info.indexOf(":") >= 0
								? info.indexOf(":") + 1
								: info.indexOf(" ");
						const parts: TextPart[] =
							split > 0
								? [
										{ text: info.slice(0, split), tone: "brand", bold: true },
										{ text: info.slice(split), tone: "plain" },
									]
								: [{ text: info, tone: "plain" }];
						return (
							decorate(
								art,
								artTones[index % artTones.length],
								false,
								enabled,
								"bold",
							) +
							"  " +
							styledParts(parts, width - 33, enabled, false, ascii)
						);
					},
				)
			: [];
	const result: { text: string; row: number }[] = [
		...prefix,
		...(prefix.length ? [" ".repeat(width)] : []),
	].map((text) => ({ text, row: -1 }));

	for (let row = 0; row < frame.rows.length; row++) {
		const active = row === selected;
		const parts = [
			{ text: `${active ? ">" : " "} `, tone: "plain" as const, fieldWidth: 2 },
			...(frame.rowParts?.[row] ?? [
				{ text: frame.rows[row], tone: "plain" as const },
			]),
		];
		const metadata =
			frame.rowMetadataParts?.[row] ??
			(frame.rowMetadata
				? [{ text: frame.rowMetadata[row] ?? "", tone: "plain" as const }]
				: []);
		const joined = metadata.map((part, index) => ({
			text: (index ? (ascii ? " | " : " · ") : "") + part.text,
			tone: part.tone,
		}));
		if (width >= 95 && metadata.length) {
			const titleWidth = Math.floor(width * 0.42);
			result.push({
				row,
				text:
					styledParts(parts, titleWidth, enabled, active, ascii) +
					styledParts(
						joined.map((part, index) => ({
							...part,
							text: (index ? "" : " ") + part.text,
						})),
						width - titleWidth,
						enabled,
						active,
						ascii,
						true,
					),
			});
		} else {
			result.push({
				row,
				text: styledParts(parts, width, enabled, active, ascii),
			});
			if (metadata.length && (width >= 58 || active))
				result.push({
					row,
					text: styledParts(
						[
							{
								text: "",
								tone: "plain",
								fieldWidth: parts
									.slice(0, -1)
									.reduce(
										(total, part) =>
											total + (part.fieldWidth ?? cells(part.text)),
										0,
									),
							},
							...joined.map((part) => ({
								...part,
								dim: part.tone !== "danger",
							})),
						],
						width,
						enabled,
						active,
						ascii,
						true,
					),
				});
		}
	}
	const selectedEnd = result.findLastIndex((line) => line.row === selected);
	const start = Math.max(0, selectedEnd - height + 1);
	return result.slice(start, start + height).map((line) => line.text);
}

function framedFrame(frame: Frame, width: number, height: number): string {
	if (width < 24 || height < 9)
		return fitHints(frame.footerHints ?? [frame.footer], width);
	const enabled = frame.color === true;
	const framed = width >= 79;
	const contentHeight = height - (framed ? 6 : 4);
	const contentWidth = width - (framed ? 4 : 0);
	const content = taskLines(frame, contentWidth, contentHeight);
	while (content.length < contentHeight) content.push(" ".repeat(contentWidth));
	const h = frame.ascii ? "-" : "─";
	const v = frame.ascii ? "|" : "│";
	const top = frame.ascii ? ["+", "+"] : ["┌", "┐"];
	const bottom = frame.ascii ? ["+", "+"] : ["└", "┘"];
	const label = clipped(
		frame.viewportTitle ?? frame.title,
		Math.max(0, width - 6),
		frame.ascii === true,
	);
	const border = label
		? `${top[0]}${h} ${label} ${h.repeat(Math.max(0, width - cells(label) - 5))}${top[1]}`
		: top[0] + h.repeat(width - 2) + top[1];
	return [
		decorate(padLine(frame.title, width), "plain", false, enabled, "bold"),
		fitLine(frame.context ?? "", width),
		...(framed ? [decorate(border, "brand", false, enabled)] : []),
		...content.map((line) =>
			framed
				? decorate(`${v} `, "brand", false, enabled) +
					line +
					decorate(` ${v}`, "brand", false, enabled)
				: line,
		),
		...(framed
			? [
					decorate(
						bottom[0] + h.repeat(width - 2) + bottom[1],
						"brand",
						false,
						enabled,
					),
				]
			: []),
		decorate(
			padLine(frame.statusLine ?? frame.status, width),
			frame.statusTone ?? "plain",
			false,
			enabled,
			frame.statusTone === "warning" || frame.statusTone === "danger"
				? "bold"
				: "dim",
		),
		fitHints(frame.footerHints ?? [frame.footer], width)
			.split(" | ")
			.map((hint) => {
				const split = hint.indexOf(" ");
				return (
					decorate(
						split < 0 ? hint : hint.slice(0, split),
						"brand",
						false,
						enabled,
						"bold",
					) +
					(split < 0
						? ""
						: decorate(hint.slice(split), "plain", false, enabled, "dim"))
				);
			})
			.join(decorate(" | ", "plain", false, enabled, "dim")),
	].join("\n");
}

export function fitHints(hints: readonly string[], columns: number): string {
	const help = hints.find((hint) => hint.startsWith("? "));
	const review =
		hints.some((hint) => hint.startsWith("y ")) ||
		(hints[0]?.startsWith("r ") && hints.some((hint) => hint.startsWith("v ")));
	const safety = review
		? hints.filter((hint) => /^(q |y |r |Esc )/u.test(hint))
		: hints.filter((hint) => /^(Esc |q |Enter )/u.test(hint));
	if (!safety.length && hints[0]) safety.push(hints[0]);
	const required = [...safety, ...(help ? [help] : [])].join(" | ");
	if (fitLine(required, columns) !== required) {
		let result = "";
		for (const hint of [...safety, ...(help ? [help] : [])]) {
			const key = hint.split(" ")[0];
			const candidate = result ? `${result} | ${key}` : key;
			if (fitLine(candidate, columns) === candidate) result = candidate;
		}
		return result;
	}
	const accepted = new Set([...safety, ...(help ? [help] : [])]);
	for (const hint of hints) {
		if (accepted.has(hint)) continue;
		const candidate = hints
			.filter((value) => accepted.has(value) || value === hint)
			.map(safeText)
			.join(" | ");
		if (fitLine(candidate, columns) === candidate) accepted.add(hint);
	}
	return hints
		.filter((hint) => accepted.has(hint))
		.map(safeText)
		.join(" | ");
}

export function wrapParts(
	lines: readonly (readonly TextPart[])[],
	columns: number,
): TextPart[][] {
	const width = Number.isFinite(columns)
		? Math.max(2, Math.min(1000, Math.floor(columns)))
		: 2;
	const result: TextPart[][] = [];
	for (const parts of lines) {
		let line: TextPart[] = [];
		let used = 0;
		for (const part of parts) {
			let text = "";
			for (const { segment } of segmenter.segment(partText(part))) {
				const count = cellWidth(segment);
				if (used + count > width) {
					if (text) line.push({ ...part, text });
					result.push(line);
					line = [];
					used = 0;
					text = "";
				}
				text += segment;
				used += count;
			}
			if (text) line.push({ ...part, text });
		}
		result.push(line);
	}
	return result;
}

export function wrapLines(
	values: readonly string[],
	columns: number,
): string[] {
	const width = Number.isFinite(columns)
		? Math.max(2, Math.min(1000, Math.floor(columns)))
		: 2;
	const result: string[] = [];
	for (const value of values) {
		let line = "";
		let used = 0;
		for (const { segment } of segmenter.segment(safeText(value))) {
			const cells = cellWidth(segment);
			if (used + cells > width) {
				result.push(line);
				line = "";
				used = 0;
			}
			line += segment;
			used += cells;
		}
		result.push(line);
	}
	return result;
}

export function wrapWords(
	values: readonly string[],
	columns: number,
): string[] {
	const width = Number.isFinite(columns)
		? Math.max(2, Math.min(1000, Math.floor(columns)))
		: 2;
	const result: string[] = [];
	for (const value of values) {
		let line = "";
		for (const word of safeText(value).trim().split(" ")) {
			const candidate = line ? `${line} ${word}` : word;
			if (visibleCells(candidate) <= width) line = candidate;
			else {
				if (line) result.push(line);
				const chunks = wrapLines([word], width);
				result.push(...chunks.slice(0, -1));
				line = chunks.at(-1) ?? "";
			}
		}
		result.push(line);
	}
	return result;
}

export function renderFrame(
	frame: Frame,
	columns: number,
	rows: number,
): string {
	const height = Number.isFinite(rows)
		? Math.max(1, Math.min(500, Math.floor(rows)))
		: 1;
	const width = Number.isFinite(columns)
		? Math.max(0, Math.min(1000, Math.floor(columns) - 1))
		: 0;
	if (frame.framed) return framedFrame(frame, width, height);
	if (height < 5 || width < 20)
		return frame.footerHints
			? fitHints(frame.footerHints, width)
			: fitLine(frame.status || frame.title, width);
	const contentHeight = height - 4;
	const rowHeight = frame.rowMetadata ? 2 : 1;
	const visibleRows = Math.max(1, Math.floor(contentHeight / rowHeight));
	const selected = Math.max(0, Math.min(frame.rows.length - 1, frame.selected));
	const start = Math.max(0, selected - visibleRows + 1);
	const content = frame.detail
		? frame.detail.slice(0, contentHeight)
		: frame.rows
				.slice(start, start + visibleRows)
				.flatMap((value, index) => [
					`${start + index === selected ? ">" : " "} ${value}`,
					...(frame.rowMetadata
						? [`  ${frame.rowMetadata[start + index] ?? ""}`]
						: []),
				])
				.slice(0, contentHeight);
	while (content.length < contentHeight) content.push("");
	const enabled = frame.color === true;
	const lines = [
		decorate(fitLine(frame.title, width), "brand", false, enabled),
		decorate(
			fitLine(frame.status, width),
			frame.statusTone ?? "info",
			false,
			enabled,
		),
		"",
		...content.map((line, index) =>
			decorate(
				fitLine(line, width),
				frame.detail
					? "plain"
					: (frame.rowTones?.[start + Math.floor(index / rowHeight)] ??
							"plain"),
				!frame.detail && start + Math.floor(index / rowHeight) === selected,
				enabled,
			),
		),
		decorate(
			frame.footerHints
				? fitHints(frame.footerHints, width)
				: fitLine(frame.footer, width),
			"brand",
			false,
			enabled,
		),
	];
	return lines.join("\n");
}
