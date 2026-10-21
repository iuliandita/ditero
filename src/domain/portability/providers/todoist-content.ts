import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
	type DraftTask,
} from "./content-common.ts";
import { parseTodoistDate } from "./todoist-date.ts";

export function dayInZone(instant: string, zone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(instant));
}

export async function parseTodoistContent(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("todoist", options);
	const anchorDay =
		options.anchorDay ?? dayInZone(options.exportedAt, options.timezone);
	builder.anchorDay = anchorDay;
	const { header, rows } = csvRecords(input, undefined, options);
	if (!["TYPE", "CONTENT"].every((key) => header.includes(key)))
		throw new ProviderImportError("invalid-csv");
	let list: string | null = null;
	const stack: string[] = [];
	let previous: DraftTask | undefined;
	builder.notice("completion-unavailable");
	for (const { record: row, number } of rows) {
		builder.row(`row:${number}`, () => {
			if (row.TYPE === "meta") {
				builder.unsupported(row, ["TYPE"]);
				builder.notice("unsupported-field", "view-settings");
				return;
			}
			if (row.TYPE === "section") {
				builder.unsupported(row, ["TYPE", "CONTENT", "DESCRIPTION"]);
				list = builder.list(
					`section:${number}`,
					builder.text(row.CONTENT ?? "", "CONTENT"),
					options.projectFolderName,
				);
				if (row.DESCRIPTION)
					builder.notice("unsupported-field", "section-description");
				stack.length = 0;
				previous = undefined;
				return;
			}
			if (row.TYPE === "note") {
				builder.unsupported(row, ["TYPE", "CONTENT"]);
				if (!previous) {
					builder.noticeAt("row-skipped");
					return;
				}
				builder.appendNote(previous, row.CONTENT ?? "", "CONTENT");
				builder.notice("comments-as-notes");
				return;
			}
			if (row.TYPE !== "task") throw new ProviderImportError("invalid-row");
			builder.unsupported(row, [
				"TYPE",
				"CONTENT",
				"DESCRIPTION",
				"PRIORITY",
				"INDENT",
				"DATE",
				"DATE_LANG",
				"TIMEZONE",
			]);
			list ??= builder.list(
				"unsectioned",
				options.unsectionedListName,
				options.projectFolderName,
			);
			let indent = Number(row.INDENT || "1");
			if (!Number.isInteger(indent) || indent < 1 || indent > 100) {
				builder.noticeAt("field-invalid", "INDENT");
				indent = 1;
			}
			if (indent > 1 && !stack[indent - 2]) {
				// Todoist indents never skip a level; a gap means the parent row was lost.
				builder.noticeAt("field-invalid", "INDENT");
				indent = Math.min(indent, stack.length + 1);
			}
			let priority = 1;
			if (row.PRIORITY) {
				if (/^[1-4]$/.test(row.PRIORITY)) priority = Number(row.PRIORITY);
				else builder.noticeAt("field-invalid", "PRIORITY");
			}
			const labels: string[] = [];
			const title = builder.text(
				(row.CONTENT ?? "")
					.replace(
						/(^|\s)@([\p{L}\p{N}_-]+)/gu,
						(_match, space: string, name: string) => {
							labels.push(builder.text(name, "CONTENT"));
							return space;
						},
					)
					.replace(/\s{2,}/g, " ")
					.trim(),
				"CONTENT",
			);
			if (!title) throw new ProviderImportError("invalid-row");
			const parsed = parseTodoistDate(
				row.DATE ?? "",
				row.DATE_LANG ?? "",
				anchorDay,
			);
			let due: ReturnType<typeof builder.date> = {
				dueAt: null,
				dueAllDay: false,
			};
			let rrule: string | null = null;
			if (parsed.kind === "date") {
				due = builder.date(
					parsed.value,
					row.TIMEZONE || options.timezone,
					"DATE",
				);
				if (parsed.rule && due.dueAt) {
					rrule = builder.recurrence(parsed.rule, "DATE");
					if (rrule && parsed.anchored)
						builder.notice("recurrence-anchor", anchorDay);
				}
			} else if (parsed.kind === "unsupported-date")
				builder.noticeAt("unsupported-date", "DATE");
			else if (parsed.kind === "unsupported-recurrence")
				builder.noticeAt("unsupported-recurrence", "DATE");
			const task: DraftTask = {
				id: `row:${number}`,
				listId: list as string,
				parentId: indent > 1 ? stack[indent - 2] : null,
				title,
				notes: row.DESCRIPTION
					? builder.notes(row.DESCRIPTION, "DESCRIPTION")
					: null,
				priority: 4 - priority,
				labels,
				rrule,
				...due,
			};
			builder.task(task);
			previous = task;
			stack.length = indent;
			stack[indent - 1] = task.id;
		});
	}
	return builder.finish(input);
}
