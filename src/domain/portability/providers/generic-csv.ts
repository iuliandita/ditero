import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
	flag,
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
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		builder.checkpoint();
		builder.unsupported(row, GENERIC_CSV_HEADER);
		const signature = JSON.stringify(row);
		if (seen.has(signature)) {
			builder.notice("duplicate-row");
			continue;
		}
		seen.add(signature);
		const list = builder.list(
			JSON.stringify([
				row.list || options.unsectionedListName,
				row.section || "",
			]),
			row.section || row.list || options.unsectionedListName,
			row.section ? row.list || options.projectFolderName : null,
		);
		if (row.priority && !/^[0-3]$/.test(row.priority))
			throw new ProviderImportError("invalid-row");
		const zone = row.timezone || options.timezone;
		builder.task({
			id: row.id || `row:${index}`,
			listId: list,
			parentId: row.parent_id || null,
			title: row.title || "",
			notes: row.notes || null,
			...builder.date(row.due || "", zone),
			priority: Number(row.priority || 0),
			labels: row.labels?.split(";").filter(Boolean) ?? [],
			done: flag(row.completed),
			completedAt: row.completed_at
				? builder.date(row.completed_at, zone).dueAt
				: null,
			rrule: builder.recurrence(row.recurrence || ""),
		});
	}
	return builder.finish(input);
}
