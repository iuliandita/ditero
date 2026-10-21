import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
	flag,
} from "./content-common.ts";

export async function parseTickTickBackup(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("ticktick", options);
	const { header, rows } = csvRecords(input, "Folder Name", options);
	if (
		!["List Name", "Title", "Status", "taskId"].every((key) =>
			header.includes(key),
		)
	)
		throw new ProviderImportError("invalid-csv");
	builder.notice("format-limits");
	const seen = new Map<string, string>();
	for (const [index, row] of rows.entries()) {
		builder.checkpoint();
		builder.unsupported(row, [
			"Folder Name",
			"List Name",
			"Title",
			"Content",
			"Tags",
			"Due Date",
			"Timezone",
			"Is All Day",
			"Priority",
			"Status",
			"Completed Time",
			"Repeat",
			"taskId",
			"parentId",
			"Column Name",
			"Kind",
			"Is Check list",
		]);
		const list = builder.list(
			JSON.stringify([
				row["Folder Name"],
				row["List Name"],
				row["Column Name"],
			]),
			[row["List Name"] || options.unsectionedListName, row["Column Name"]]
				.filter(Boolean)
				.join(" / "),
			row["Folder Name"] || null,
		);
		const priority = row.Priority || "0";
		if (!["0", "1", "3", "5"].includes(priority))
			throw new ProviderImportError("invalid-row");
		const state = row.Status || "0";
		if (!["0", "1", "2", "-1"].includes(state))
			builder.notice("unknown-state", "Status");
		if (state === "2" || state === "-1") builder.notice("archive-state");
		if (state === "2" && !row["Completed Time"])
			builder.notice("unknown-state", "Status");
		if (row.Kind && !["TEXT", "CHECKLIST"].includes(row.Kind))
			builder.notice("unsupported-field", "Kind");
		const zone = row.Timezone || options.timezone;
		let due = builder.date(row["Due Date"] || "", zone);
		if (due.dueAt && flag(row["Is All Day"])) {
			const day = new Intl.DateTimeFormat("en-CA", {
				timeZone: zone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).format(new Date(due.dueAt));
			due = builder.date(day, zone);
		}
		const id = row.taskId || `row:${index}`;
		if (seen.has(id)) {
			if (seen.get(id) !== JSON.stringify(row))
				throw new ProviderImportError("invalid-graph");
			builder.notice("duplicate-row");
			continue;
		}
		seen.set(id, JSON.stringify(row));
		const content = row.Content || "";
		const checklist = flag(row["Is Check list"]) || row.Kind === "CHECKLIST";
		const lines = content.split(/\r?\n/);
		const notes = checklist
			? lines.filter((line) => !/^[▫▪]/.test(line)).join("\n")
			: content;
		builder.task({
			id,
			listId: list,
			parentId: row.parentId || null,
			title: row.Title || "",
			notes,
			priority:
				priority === "5" ? 3 : priority === "3" ? 2 : priority === "1" ? 1 : 0,
			done: state === "1" || (state === "2" && !!row["Completed Time"]),
			completedAt: row["Completed Time"]
				? builder.date(row["Completed Time"], zone).dueAt
				: null,
			labels: row.Tags ? row.Tags.split(/,\s*/).filter(Boolean) : [],
			rrule: builder.recurrence(row.Repeat || ""),
			...due,
		});
		if (checklist)
			for (const [lineIndex, line] of lines.entries())
				if (/^[▫▪]/.test(line)) {
					builder.task({
						id: `${id}:check:${lineIndex}`,
						listId: list,
						parentId: id,
						title: line.slice(1).trim(),
						done: line[0] === "▪",
					});
				}
	}
	return builder.finish(input);
}
