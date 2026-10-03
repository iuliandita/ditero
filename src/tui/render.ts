const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function safeText(value: string): string {
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
	})
		.join("")
		.replace(/\s+/gu, " ");
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

export function fitLine(value: string, columns: number): string {
	const limit = Number.isFinite(columns)
		? Math.max(0, Math.min(1000, Math.floor(columns)))
		: 0;
	let result = "";
	let used = 0;
	for (const { segment } of segmenter.segment(safeText(value))) {
		const width = cellWidth(segment);
		if (used + width > limit) break;
		result += segment;
		used += width;
	}
	return result;
}

export interface Frame {
	title: string;
	status: string;
	footer: string;
	rows: readonly string[];
	selected: number;
	detail?: readonly string[];
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
	if (height < 5 || width < 20)
		return fitLine(frame.status || frame.title, width);
	const contentHeight = height - 4;
	const selected = Math.max(0, Math.min(frame.rows.length - 1, frame.selected));
	const start = Math.max(0, selected - contentHeight + 1);
	const content = frame.detail
		? frame.detail.slice(0, contentHeight)
		: frame.rows
				.slice(start, start + contentHeight)
				.map(
					(value, index) =>
						`${start + index === selected ? ">" : " "} ${value}`,
				);
	while (content.length < contentHeight) content.push("");
	return [frame.title, frame.status, "", ...content, frame.footer]
		.map((line) => fitLine(line, width))
		.join("\n");
}
