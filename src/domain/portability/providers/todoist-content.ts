import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	csvRecords,
	type DraftTask,
} from "./content-common.ts";

export async function parseTodoistContent(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("todoist", options);
	const { header, rows } = csvRecords(input, undefined, options);
	if (!["TYPE", "CONTENT"].every((key) => header.includes(key)))
		throw new ProviderImportError("invalid-csv");
	let list = builder.list(
		"unsectioned",
		options.unsectionedListName,
		options.projectFolderName,
	);
	const stack: string[] = [];
	let previous: DraftTask | undefined;
	builder.notice("completion-unavailable");
	for (const [index, row] of rows.entries()) {
		builder.checkpoint();

		if (row.TYPE === "meta") {
			builder.unsupported(row, ["TYPE"]);
			builder.notice("unsupported-field", "view-settings");
			continue;
		}
		if (row.TYPE === "section") {
			builder.unsupported(row, ["TYPE", "CONTENT", "DESCRIPTION"]);
			list = builder.list(
				`section:${index}`,
				row.CONTENT ?? "",
				options.projectFolderName,
			);
			if (row.DESCRIPTION)
				builder.notice("unsupported-field", "section-description");
			stack.length = 0;
			previous = undefined;
			continue;
		}
		if (row.TYPE === "note") {
			builder.unsupported(row, ["TYPE", "CONTENT"]);
			if (!previous) throw new ProviderImportError("invalid-graph");
			builder.appendNote(previous, row.CONTENT ?? "");
			builder.notice("comments-as-notes");
			continue;
		}
		if (row.TYPE !== "task")
			throw new ProviderImportError("unsupported-content");
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
		const indent = Number(row.INDENT || "1");
		if (
			!Number.isInteger(indent) ||
			indent < 1 ||
			indent > 100 ||
			(indent > 1 && !stack[indent - 2])
		)
			throw new ProviderImportError("invalid-graph");
		if (row.PRIORITY && !/^[1-4]$/.test(row.PRIORITY))
			throw new ProviderImportError("invalid-row");
		const labels: string[] = [];
		const title = (row.CONTENT ?? "")
			.replace(
				/(^|\s)@([\p{L}\p{N}_-]+)/gu,
				(_match, space: string, name: string) => {
					labels.push(name);
					return space;
				},
			)
			.trim();
		let date = row.DATE ?? "",
			rrule: string | null = null;
		const recurring =
			/^(every (?:day|week|month|year|weekday)) starting (\d{4}-\d{2}-\d{2})$/i.exec(
				date,
			);
		if (recurring && (!row.DATE_LANG || row.DATE_LANG === "en")) {
			rrule = builder.recurrence(recurring[1] ?? "");
			date = recurring[2] ?? "";
		} else if (/^every\b/i.test(date)) builder.notice("unsupported-recurrence");
		const task: DraftTask = {
			id: `row:${index}`,
			listId: list,
			parentId: indent > 1 ? stack[indent - 2] : null,
			title,
			notes: row.DESCRIPTION || null,
			priority: 4 - Number(row.PRIORITY || "1"),
			labels,
			rrule,
			...builder.date(date, row.TIMEZONE || options.timezone),
		};
		builder.task(task);
		previous = task;
		stack.length = indent;
		stack[indent - 1] = task.id;
	}
	return builder.finish(input);
}
