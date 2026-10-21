import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
	type DateOrder,
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
const DATE_COLUMNS = ["Due Date", "Date Completed"] as const;
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

// Outlook writes dates in the Windows regional order, so the order must come from the
// data or from the user, never from an English default.
function resolveDateOrder(
	rows: { record: Record<string, string> }[],
	requested: DateOrder | "auto" | null | undefined,
): DateOrder {
	let monthFirst = false;
	let dayFirst = false;
	for (const { record } of rows)
		for (const column of DATE_COLUMNS) {
			const match = NUMERIC_DATE.exec(record[column]?.trim() ?? "");
			if (!match) continue;
			if (Number(match[1]) > 12) dayFirst = true;
			if (Number(match[2]) > 12) monthFirst = true;
		}
	if (dayFirst && monthFirst)
		throw new ProviderImportError("date-order-conflict");
	if (requested === "mdy" || requested === "dmy") {
		if (
			(requested === "mdy" && dayFirst) ||
			(requested === "dmy" && monthFirst)
		)
			throw new ProviderImportError("date-order-conflict");
		return requested;
	}
	if (dayFirst) return "dmy";
	if (monthFirst) return "mdy";
	const ambiguous = rows.some(({ record }) =>
		DATE_COLUMNS.some((column) =>
			NUMERIC_DATE.test(record[column]?.trim() ?? ""),
		),
	);
	if (ambiguous) throw new ProviderImportError("date-order-required");
	return "mdy";
}
function outlookDay(value: string, order: DateOrder): string {
	if (!value) return "";
	const match = NUMERIC_DATE.exec(value.trim());
	if (!match) return value;
	const [first, second] = [match[1] ?? "", match[2] ?? ""];
	const [month, day] = order === "mdy" ? [first, second] : [second, first];
	return `${match[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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
	const order = resolveDateOrder(rows, options.dateOrder);
	builder.dateOrder = order;
	builder.notice("date-order", order);
	const list = builder.list(
		"tasks",
		options.unsectionedListName,
		options.projectFolderName,
	);
	builder.notice("format-limits");
	builder.notice("partial-export");
	for (const { record: row, number } of rows) {
		builder.row(`row:${number}`, () => {
			builder.unsupported(row, [
				"Subject",
				"Due Date",
				"Date Completed",
				"Categories",
				"Notes",
				"Priority",
				"Status",
				"Private",
				"Sensitivity",
			]);
			if (
				builder.flag(row.Private, "Private") ||
				!["", "Normal", "0"].includes(row.Sensitivity ?? "")
			)
				builder.notice("private-items");
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
			let priority = new Map([
				["Low", 1],
				["Normal", 0],
				["High", 3],
				["0", 1],
				["1", 0],
				["2", 3],
				["", 0],
			]).get(row.Priority || "");
			if (priority === undefined) {
				builder.noticeAt("field-invalid", "Priority");
				priority = 0;
			}
			builder.task({
				id: `row:${number}`,
				listId: list,
				title: builder.text(row.Subject || "", "Subject"),
				notes: row.Notes ? builder.notes(row.Notes, "Notes") : null,
				...builder.date(
					outlookDay(row["Due Date"] || "", order),
					undefined,
					"Due Date",
				),
				done,
				priority,
				completedAt:
					done && row["Date Completed"]
						? builder.date(
								outlookDay(row["Date Completed"], order),
								undefined,
								"Date Completed",
							).dueAt
						: null,
				labels:
					row.Categories?.split(/[;,]/)
						.map((label) => builder.text(label.trim(), "Categories"))
						.filter(Boolean) ?? [],
			});
		});
	}
	return builder.finish(input);
}
