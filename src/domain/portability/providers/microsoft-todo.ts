import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
} from "./content-common.ts";

const OUTLOOK_COLUMNS = [
	"Subject",
	"Start Date",
	"Due Date",
	"Reminder On/Off",
	"Reminder Date",
	"Reminder Time",
	"Date Completed",
	"% Complete",
	"Total Work",
	"Actual Work",
	"Billing Information",
	"Categories",
	"Companies",
	"Contacts",
	"Mileage",
	"Notes",
	"Priority",
	"Private",
	"Role",
	"Schedule+ Priority",
	"Sensitivity",
	"Status",
];
function outlookDay(value: string): string {
	if (!value) return "";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
	if (!match) return value;
	return `${match[3]}-${match[1]?.padStart(2, "0")}-${match[2]?.padStart(2, "0")}`;
}
export async function parseMicrosoftTodoCsv(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("microsoft", options);
	const { header, rows } = csvRecords(input, undefined, options);
	if (
		!["Subject", "Status", "Notes"].every((key) => header.includes(key)) ||
		header.some((key) => !OUTLOOK_COLUMNS.includes(key))
	)
		throw new ProviderImportError("invalid-csv");
	const list = builder.list(
		"tasks",
		options.unsectionedListName,
		options.projectFolderName,
	);
	builder.notice("format-limits");
	builder.notice("partial-export");
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		builder.checkpoint();
		builder.unsupported(row, [
			"Subject",
			"Due Date",
			"Date Completed",
			"Categories",
			"Notes",
			"Priority",
			"Status",
		]);
		const signature = JSON.stringify(row);
		if (seen.has(signature)) {
			builder.notice("duplicate-row");
			continue;
		}
		seen.add(signature);
		const status = row.Status || "Not Started";
		const done = ["Completed", "2"].includes(status);
		if (
			![
				"Not Started",
				"In Progress",
				"Completed",
				"Waiting on someone else",
				"Deferred",
				"0",
				"1",
				"2",
				"3",
				"4",
			].includes(status)
		)
			builder.notice("unknown-state", "Status");
		if (
			[
				"In Progress",
				"Waiting on someone else",
				"Deferred",
				"1",
				"3",
				"4",
			].includes(status)
		)
			builder.notice("unsupported-field", "Status");
		const priority = new Map([
			["Low", 1],
			["Normal", 0],
			["High", 3],
			["0", 1],
			["1", 0],
			["2", 3],
			["", 0],
		]).get(row.Priority || "");
		if (priority === undefined) throw new ProviderImportError("invalid-row");
		builder.task({
			id: `row:${index}`,
			listId: list,
			title: row.Subject || "",
			notes: row.Notes || null,
			...builder.date(outlookDay(row["Due Date"] || "")),
			done,
			priority,
			completedAt: row["Date Completed"]
				? builder.date(outlookDay(row["Date Completed"])).dueAt
				: null,
			labels:
				row.Categories?.split(/[;,]/)
					.map((label) => label.trim())
					.filter(Boolean) ?? [],
		});
	}
	return builder.finish(input);
}
