import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	contentJson,
	flag,
	items,
	nonempty,
	record,
} from "./content-common.ts";

function trelloId(value: unknown): string {
	const id = nonempty(value);
	if (!/^[0-9a-f]{24}$/i.test(id)) throw new ProviderImportError("invalid-row");
	return id.toLowerCase();
}
function text(value: unknown, max = 100_000): string {
	if (typeof value !== "string") throw new ProviderImportError("invalid-row");
	return value.length > max ? value.slice(0, max) : value;
}
function dueText(builder: ContentBuilder, value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value.slice(0, 100);
	builder.noticeAt("unsupported-date", "due");
	return "";
}
// Original file position, kept because rows are processed in board order.
const positions = new WeakMap<object, number>();
function ordered(values: unknown[]) {
	return values
		.map((value, index) => {
			const row = record(value);
			if (typeof row.pos !== "number" || !Number.isFinite(row.pos))
				throw new ProviderImportError("invalid-row");
			positions.set(row, index + 1);
			return Object.assign(row, { pos: row.pos });
		})
		.sort(
			(a, b) => a.pos - b.pos || String(a.id).localeCompare(String(b.id), "en"),
		);
}
export async function parseTrelloContent(
	input: Uint8Array,
	options: ContentOptions,
) {
	const builder = new ContentBuilder("trello", options);
	const board = contentJson(input),
		boardId = trelloId(board.id),
		name = builder.text(nonempty(board.name, 4_000), "name");
	builder.unsupported(board, [
		"id",
		"name",
		"lists",
		"cards",
		"checklists",
		"actions",
		"labels",
		"closed",
	]);
	if (flag(board.closed)) builder.notice("archive-state", "board");
	builder.notice("partial-export");
	const archivedLists = new Set<string>();
	for (const list of ordered(items(board.lists))) {
		if (list.idBoard !== undefined && trelloId(list.idBoard) !== boardId)
			throw new ProviderImportError("invalid-graph");
		if (builder.lists.has(trelloId(list.id)))
			throw new ProviderImportError("invalid-graph");
		builder.row(`list:${positions.get(list)}`, () => {
			builder.list(
				trelloId(list.id),
				builder.text(nonempty(list.name, 4_000), "name"),
				name,
			);
			if (flag(list.closed)) {
				archivedLists.add(trelloId(list.id));
				builder.notice("archive-state", "lists");
			}
			builder.unsupported(list, ["id", "idBoard", "name", "pos", "closed"]);
		});
	}
	const labelNames = new Map<string, string>();
	for (const value of items(board.labels ?? [])) {
		const label = record(value),
			id = trelloId(label.id);
		if (labelNames.has(id)) throw new ProviderImportError("invalid-graph");
		builder.unsupported(label, ["id", "name"]);
		labelNames.set(
			id,
			builder.text(text(label.name || label.color || "label"), "labels"),
		);
	}
	const seenCards = new Map<string, string>();

	for (const card of ordered(items(board.cards))) {
		builder.checkpoint();
		const cardId = trelloId(card.id),
			signature = JSON.stringify(card);
		if (seenCards.has(cardId)) {
			if (seenCards.get(cardId) !== signature)
				throw new ProviderImportError("invalid-graph");
			builder.notice("duplicate-row");
			continue;
		}
		seenCards.set(cardId, signature);
		if (card.idBoard !== undefined && trelloId(card.idBoard) !== boardId)
			throw new ProviderImportError("invalid-graph");
		if (card.cardRole != null || flag(card.isTemplate))
			throw new ProviderImportError("unsupported-content");
		builder.row(`card:${positions.get(card)}`, () => {
			const listId = trelloId(card.idList);
			// Archived cards, and cards of archived lists, are finished work: importing
			// them as open tasks would bury the live board.
			const archived = flag(card.closed) || archivedLists.has(listId);
			if (archived) builder.notice("archived-completed", "cards");
			builder.unsupported(card, [
				"id",
				"name",
				"desc",
				"idBoard",
				"idList",
				"pos",
				"due",
				"dueComplete",
				"closed",
				"labels",
				"idLabels",
				"idChecklists",
				"isTemplate",
				"cardRole",
			]);
			const labels = items(card.labels ?? []).map((value) => {
				const label = record(value);
				builder.unsupported(label, ["id", "name"]);
				return builder.text(
					text(label.name || label.color || "label"),
					"labels",
				);
			});
			for (const value of items(card.idLabels ?? [])) {
				const label = labelNames.get(trelloId(value));
				if (!label && !labels.length)
					throw new ProviderImportError("invalid-graph");
				if (label) labels.push(label);
			}
			builder.task({
				id: cardId,
				listId,
				title: builder.text(text(card.name), "name"),
				notes:
					card.desc == null ? null : builder.notes(text(card.desc), "desc"),
				...builder.date(dueText(builder, card.due), undefined, "due"),
				done: flag(card.dueComplete) || archived,
				labels,
			});
		});
	}
	const seenChecklists = new Set<string>();
	const expectedChecklists = new Set(
		items(board.cards).flatMap((card) =>
			items(record(card).idChecklists ?? []).map(trelloId),
		),
	);
	for (const value of items(board.checklists ?? [])) {
		const checklist = record(value),
			checklistId = trelloId(checklist.id),
			parent = builder.tasks.get(trelloId(checklist.idCard));
		if (seenChecklists.has(checklistId))
			throw new ProviderImportError("invalid-graph");
		seenChecklists.add(checklistId);
		if (!parent) {
			// The card was archived out of the export or skipped; its items have no home.
			builder.notice("unsupported-field", "orphan-checklist");
			continue;
		}
		if (
			checklist.idBoard !== undefined &&
			trelloId(checklist.idBoard) !== boardId
		)
			throw new ProviderImportError("invalid-graph");
		builder.unsupported(checklist, ["id", "idCard", "checkItems"]);
		for (const item of ordered(items(checklist.checkItems))) {
			builder.row(`item:${positions.get(item)}`, () => {
				if (item.state !== "complete" && item.state !== "incomplete")
					throw new ProviderImportError("invalid-row");
				builder.unsupported(item, ["id", "name", "state", "pos", "due"]);
				builder.task({
					id: trelloId(item.id),
					listId: parent.listId,
					parentId: parent.id,
					title: builder.text(text(item.name), "name"),
					done: item.state === "complete",
					...builder.date(dueText(builder, item.due), undefined, "due"),
				});
			});
		}
	}
	for (const id of expectedChecklists)
		if (!seenChecklists.has(id))
			builder.notice("unsupported-field", "missing-checklist");
	const actions = new Map<string, string>();
	const comments: { task: string; note: string; date: string }[] = [];
	for (const value of items(board.actions ?? [])) {
		const action = record(value),
			id = trelloId(action.id);
		if (actions.has(id)) {
			if (actions.get(id) !== JSON.stringify(action))
				throw new ProviderImportError("invalid-graph");
			builder.notice("duplicate-row");
			continue;
		}
		actions.set(id, JSON.stringify(action));
		if (action.type !== "commentCard") {
			builder.notice("unsupported-field", "actions");
			continue;
		}
		const data = record(action.data),
			card = record(data.card),
			task = builder.tasks.get(trelloId(card.id));
		if (!task) {
			builder.notice("unsupported-field", "orphan-comment");
			continue;
		}
		builder.unsupported(action, [
			"id",
			"type",
			"data",
			"date",
			"idMemberCreator",
			"memberCreator",
		]);
		builder.unsupported(data, ["card", "text"]);
		const when =
			typeof action.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(action.date)
				? action.date
				: "";
		comments.push({ task: task.id, note: text(data.text), date: when });
		builder.notice("comments-as-notes");
	}
	// Trello lists comments newest first; notes read oldest first, with the day when known.
	for (const [index, comment] of comments
		.map((value, index) => ({ ...value, index }))
		.sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index)
		.entries()) {
		const task = builder.tasks.get(comment.task);
		if (!task) continue;
		builder.at = `comment:${index + 1}`;
		builder.appendNote(
			task,
			comment.date
				? `${comment.date.slice(0, 10)}: ${comment.note}`
				: comment.note,
			"comment",
		);
		builder.at = "";
	}
	return builder.finish(input);
}
