import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
} from "./content-common.ts";
import { dayInZone } from "./todoist-content.ts";

export async function parseTickTickBackup(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("ticktick", options);
	// Real backups contain rows with unescaped delimiters, so alignment is best effort.
	const { header, rows, misaligned } = csvRecords(
		input,
		"Folder Name",
		options,
		true,
	);
	if (
		!["List Name", "Title", "Status", "taskId"].every((key) =>
			header.includes(key),
		)
	)
		throw new ProviderImportError("invalid-csv");
	builder.notice("format-limits");
	for (const number of misaligned) builder.skipped(`row:${number}`);
	const listKey = (row: Record<string, string>) =>
		JSON.stringify([row["Folder Name"], row["List Name"], row["Column Name"]]);
	// Subtasks live in their parent's list whatever column the backup names for them.
	const known = new Map<string, Record<string, string>>();
	for (const { record } of rows)
		if (record.taskId && record.Title?.trim()) known.set(record.taskId, record);
	const listOf = (row: Record<string, string>): Record<string, string> => {
		let current = row;
		for (let depth = 0; depth < 200 && current.parentId; depth++) {
			const parent = known.get(current.parentId);
			if (!parent || parent === current) break;
			current = parent;
		}
		return current;
	};
	const seen = new Map<string, string>();
	for (const { record: row, number, short } of rows) {
		builder.row(`row:${number}`, () => {
			if (short) builder.noticeAt("row-ragged");
			builder.unsupported(row, [
				"Folder Name",
				"List Name",
				"Title",
				"Content",
				"Tags",
				"Due Date",
				"Timezone",
				"Is All Day",
				"Is Floating",
				"Priority",
				"Status",
				"Completed Time",
				"Repeat",
				"taskId",
				"parentId",
				"Column Name",
				"Kind",
				"Is Check list",
				"Created Time",
				"Order",
				"Column Order",
				"View Mode",
				"projectKind",
			]);
			const home = listOf(row);
			const list = builder.list(
				listKey(home),
				builder.text(
					[
						home["List Name"] || options.unsectionedListName,
						home["Column Name"],
					]
						.filter(Boolean)
						.join(" / "),
					"List Name",
				),
				home["Folder Name"] || null,
			);
			let priority = row.Priority || "0";
			if (!["0", "1", "3", "5"].includes(priority)) {
				builder.noticeAt("field-invalid", "Priority");
				priority = "0";
			}
			const state = row.Status || "0";
			if (!["0", "1", "2", "-1"].includes(state))
				builder.noticeAt("unknown-state", "Status");
			// Archived (2) and "won't do" (-1) tasks are finished items, not open work.
			const done = state === "1" || state === "2" || state === "-1";
			if (state === "2" || state === "-1")
				builder.noticeAt("archived-completed", "Status");
			let zone = options.timezone;
			if (row.Timezone) {
				try {
					dayInZone(options.exportedAt, row.Timezone);
					zone = row.Timezone;
				} catch {
					builder.noticeAt("field-invalid", "Timezone");
				}
			}
			const dueText = row["Due Date"] || "";
			let due = builder.date(dueText, zone, "Due Date");
			if (due.dueAt && builder.flag(row["Is Floating"], "Is Floating"))
				// Floating times are wall-clock values: keep the clock, not the instant.
				due = builder.date(
					dueText.replace(/([+-]\d{2}:?\d{2}|Z)$/, "").slice(0, 19),
					options.timezone,
					"Due Date",
				);
			else if (due.dueAt && builder.flag(row["Is All Day"], "Is All Day"))
				due = builder.date(dayInZone(due.dueAt, zone), zone, "Due Date");
			const id = row.taskId || `row:${number}`;
			if (seen.has(id)) {
				if (seen.get(id) !== JSON.stringify(row))
					throw new ProviderImportError("invalid-graph");
				builder.notice("duplicate-row");
				return;
			}
			const content = row.Content || "";
			const checklist =
				builder.flag(row["Is Check list"], "Is Check list") ||
				row.Kind === "CHECKLIST";
			const lines = content.split(/\r?\n/);
			const notes = checklist
				? lines.filter((line) => !/^[▫▪]/.test(line)).join("\n")
				: content;
			const parentId =
				row.parentId && row.parentId !== id && known.has(row.parentId)
					? row.parentId
					: null;
			if (row.parentId && !parentId)
				builder.noticeAt("field-invalid", "parentId");
			builder.task({
				id,
				listId: list,
				parentId,
				title: builder.text(row.Title || "", "Title"),
				notes: builder.notes(notes, "Content"),
				priority:
					priority === "5"
						? 3
						: priority === "3"
							? 2
							: priority === "1"
								? 1
								: 0,
				done,
				completedAt:
					done && row["Completed Time"]
						? builder.date(row["Completed Time"], zone, "Completed Time").dueAt
						: null,
				labels: (row.Tags ? row.Tags.split(/,\s*/) : [])
					.map((tag) => builder.text(tag, "Tags"))
					.filter(Boolean),
				rrule: builder.recurrence(row.Repeat || "", "Repeat"),
				...due,
			});
			seen.set(id, JSON.stringify(row));
			if (checklist)
				for (const [lineIndex, line] of lines.entries())
					if (/^[▫▪]/.test(line)) {
						const title = builder.text(line.slice(1).trim(), "Content");
						if (!title) {
							builder.noticeAt("row-skipped", "Content");
							continue;
						}
						builder.task({
							id: `${id}:check:${lineIndex}`,
							listId: list,
							parentId: id,
							title,
							done: line[0] === "▪",
						});
					}
		});
	}
	return builder.finish(input);
}
