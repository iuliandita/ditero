import { ProviderImportError } from "./common.ts";
import {
	ContentBuilder,
	type ContentOptions,
	contentJson,
	flag,
	items,
	nonempty,
	record,
	string,
} from "./content-common.ts";

function trelloId(value: unknown): string {
	const id = nonempty(value);
	if (!/^[0-9a-f]{24}$/i.test(id)) throw new ProviderImportError("invalid-row");
	return id.toLowerCase();
}
function ordered(values: unknown[]) {
	return values
		.map((value) => {
			const row = record(value);
			if (typeof row.pos !== "number" || !Number.isFinite(row.pos))
				throw new ProviderImportError("invalid-row");
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
		name = nonempty(board.name);
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
	if (flag(board.closed)) builder.notice("archive-state");
	builder.notice("partial-export");
	for (const list of ordered(items(board.lists))) {
		if (list.idBoard !== undefined && trelloId(list.idBoard) !== boardId)
			throw new ProviderImportError("invalid-graph");
		if (builder.lists.has(trelloId(list.id)))
			throw new ProviderImportError("invalid-graph");
		builder.list(trelloId(list.id), nonempty(list.name), name);
		if (flag(list.closed)) builder.notice("archive-state");
		builder.unsupported(list, ["id", "idBoard", "name", "pos", "closed"]);
	}
	const labelNames = new Map<string, string>();
	for (const value of items(board.labels ?? [])) {
		const label = record(value),
			id = trelloId(label.id);
		if (labelNames.has(id)) throw new ProviderImportError("invalid-graph");
		builder.unsupported(label, ["id", "name"]);
		labelNames.set(id, string(label.name || label.color || "label"));
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
		if (flag(card.closed)) builder.notice("archive-state");
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
			return string(label.name || label.color || "label");
		});
		for (const value of items(card.idLabels ?? [])) {
			const label = labelNames.get(trelloId(value));
			if (!label && !labels.length)
				throw new ProviderImportError("invalid-graph");
			if (label) labels.push(label);
		}
		builder.task({
			id: trelloId(card.id),
			listId: trelloId(card.idList),
			title: nonempty(card.name),
			notes: card.desc == null ? null : string(card.desc, 32_767),
			...builder.date(card.due == null ? "" : string(card.due)),
			done: flag(card.dueComplete),
			labels,
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
		if (seenChecklists.has(checklistId) || !parent)
			throw new ProviderImportError("invalid-graph");
		if (
			checklist.idBoard !== undefined &&
			trelloId(checklist.idBoard) !== boardId
		)
			throw new ProviderImportError("invalid-graph");
		seenChecklists.add(checklistId);
		builder.unsupported(checklist, ["id", "idCard", "checkItems"]);
		for (const item of ordered(items(checklist.checkItems))) {
			if (item.state !== "complete" && item.state !== "incomplete")
				throw new ProviderImportError("invalid-row");
			builder.unsupported(item, ["id", "name", "state", "pos", "due"]);
			builder.task({
				id: trelloId(item.id),
				listId: parent.listId,
				parentId: parent.id,
				title: nonempty(item.name),
				done: item.state === "complete",
				...builder.date(item.due == null ? "" : string(item.due)),
			});
		}
	}
	for (const id of expectedChecklists)
		if (!seenChecklists.has(id))
			builder.notice("unsupported-field", "missing-checklist");
	const actions = new Map<string, string>();
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
		builder.appendNote(task, string(data.text, 32_767));
		builder.notice("comments-as-notes");
	}
	return builder.finish(input);
}
