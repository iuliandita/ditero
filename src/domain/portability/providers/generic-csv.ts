import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
} from "./content-common.ts";

export const GENERIC_CSV_HEADER = [
	"id",
	"list",
	"section",
	"parent_id",
	"title",
	"notes",
	"due",
	"timezone",
	"priority",
	"labels",
	"completed",
	"completed_at",
	"recurrence",
] as const;
export async function parseGenericCsv(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("generic-csv", options);
	const { header, rows } = csvRecords(input, undefined, options);
	if (!header.includes("title")) throw new ProviderImportError("invalid-csv");
	for (const { record: row, number } of rows) {
		builder.row(`row:${number}`, () => {
			builder.unsupported(row, GENERIC_CSV_HEADER);
			const list = builder.list(
				JSON.stringify([
					row.list || options.unsectionedListName,
					row.section || "",
				]),
				builder.text(
					row.section || row.list || options.unsectionedListName,
					row.section ? "section" : "list",
				),
				row.section
					? builder.text(row.list || options.projectFolderName, "list")
					: null,
			);
			let priority = 0;
			if (row.priority) {
				if (/^[0-3]$/.test(row.priority)) priority = Number(row.priority);
				else builder.noticeAt("field-invalid", "priority");
			}
			const zone = row.timezone || options.timezone;
			const done = builder.flag(row.completed, "completed");
			builder.task({
				id: row.id || `row:${number}`,
				listId: list,
				parentId: row.parent_id || null,
				title: builder.text(row.title || "", "title"),
				notes: row.notes ? builder.notes(row.notes, "notes") : null,
				...builder.date(row.due || "", zone, "due"),
				priority,
				labels: (row.labels?.split(";") ?? [])
					.map((label) => builder.text(label.trim(), "labels"))
					.filter(Boolean),
				done,
				completedAt:
					done && row.completed_at
						? builder.date(row.completed_at, zone, "completed_at").dueAt
						: null,
				rrule: builder.recurrence(row.recurrence || "", "recurrence"),
			});
		});
	}
	return builder.finish(input);
}
