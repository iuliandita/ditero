import type { z } from "zod";
import { CliError } from "../cli/arguments.ts";
import { MAX_PAGES } from "../cli/client.ts";
import { encodeTaskPlacementInput } from "../cli/task-placement-workflow.ts";
import {
	type apiListObservationSchema,
	canonicalApiListSnapshot,
} from "../domain/public-api-list-update.ts";
import type { ApiTask } from "../domain/public-api-resources.ts";
import {
	type ApiTaskPlacement,
	type apiTaskPlacementObservationSchema,
	parseApiTaskPlacement,
	placementSortKeySchema,
} from "../domain/public-api-task-placement.ts";
import { keyBetween } from "../domain/sort-key.ts";

export type PlacementObservation = z.infer<
	typeof apiTaskPlacementObservationSchema
>;
export type ListObservation = z.infer<typeof apiListObservationSchema>;

// Every sibling must be read to order a task, so the row ceiling is the
// current client page bound at the page size the reader requests.
export const ORDER_PAGE_LIMIT = 100;
export const MAX_ORDER_ROWS = MAX_PAGES * ORDER_PAGE_LIMIT;

export interface OrderSibling {
	readonly id: string;
	readonly title: string;
	readonly sortKey: string;
	readonly done: boolean;
}
export interface OrderAnchor {
	readonly id: string;
	readonly title: string;
	readonly sortKey: string;
}
// Observed once, before any review; nothing here is refreshed or rebased.
export interface OrderingPlan {
	readonly taskId: string;
	readonly title: string;
	readonly workspaceId: string;
	readonly listId: string;
	readonly parentId: string | null;
	readonly parentTitle: string | null;
	readonly siblings: readonly OrderSibling[];
	readonly index: number;
	readonly childCount: number;
	readonly placementToken: string;
	readonly listToken: string;
}
// Frozen with the request body; retries reuse it unchanged.
export interface OrderReview {
	readonly from: number;
	readonly to: number;
	readonly total: number;
	readonly key: string;
	readonly after: OrderAnchor | null;
	readonly before: OrderAnchor | null;
	readonly parentId: string | null;
	readonly parentTitle: string | null;
	readonly childCount: number;
}
export interface OrderProposal {
	readonly body: ApiTaskPlacement;
	readonly order: OrderReview;
}

function refuse(code: string): never {
	throw new CliError(
		code,
		"Reload the order to start from a fresh bounded read.",
		8,
	);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The scalar task fields the discovery row and the placement snapshot share,
// in fixed order. Placement-only recurrence state is not in the discovery DTO.
function sharedTaskFields(
	value: ApiTask,
	listKind: PlacementObservation["snapshot"]["task"]["listKind"],
) {
	return [
		value.id,
		value.listId,
		value.workspaceId,
		value.title,
		value.notes,
		value.dueAt,
		value.dueAllDay,
		value.priority,
		value.createdAt,
		value.done,
		value.completedAt,
		value.rrule,
		value.recurrenceRelative,
		listKind,
	];
}
function sameSharedTask(
	row: ApiTask,
	task: PlacementObservation["snapshot"]["task"],
	list: ListObservation["snapshot"],
): boolean {
	const observed = sharedTaskFields(
		{
			id: task.taskId,
			listId: task.listId,
			workspaceId: task.workspaceId,
			title: task.title,
			notes: task.notes,
			dueAt: task.dueAt,
			dueAllDay: task.dueAllDay,
			priority: task.priority,
			createdAt: task.createdAt,
			done: task.done,
			completedAt: task.completedAt,
			rrule: task.rrule,
			recurrenceRelative: task.recurrenceRelative,
		} as ApiTask,
		task.listKind,
	);
	return (
		JSON.stringify(sharedTaskFields(row, list.kind)) ===
		JSON.stringify(observed)
	);
}

export function planOrdering(input: {
	rows: readonly ApiTask[];
	taskId: string;
	listId: string;
	placement: PlacementObservation;
	list: ListObservation;
}): OrderingPlan {
	const { rows, taskId, listId, placement, list } = input;
	const task = placement.snapshot.task;
	if (rows.length > MAX_ORDER_ROWS) refuse("ordering_bounds");
	if (
		task.taskId !== taskId ||
		task.listId !== listId ||
		placement.snapshot.list.id !== listId ||
		list.snapshot.id !== listId ||
		list.snapshot.workspaceId !== task.workspaceId ||
		canonicalApiListSnapshot(placement.snapshot.list) !==
			canonicalApiListSnapshot(list.snapshot)
	)
		refuse("ordering_stale");
	const ids = new Set<string>();
	for (const row of rows) {
		if (row.listId !== listId || row.workspaceId !== task.workspaceId)
			refuse("ordering_scope");
		if (ids.has(row.id)) refuse("ordering_duplicate");
		ids.add(row.id);
	}
	const selected = rows.find((row) => row.id === taskId);
	if (
		!selected ||
		selected.parentId !== placement.snapshot.parentId ||
		selected.sortKey !== placement.snapshot.sortKey ||
		!sameSharedTask(selected, task, list.snapshot)
	)
		refuse("ordering_stale");
	// Done rows are siblings; only the exact same parent forms the group.
	const group = rows.filter((row) => row.parentId === selected.parentId);
	if (
		group.some((row) => !placementSortKeySchema.safeParse(row.sortKey).success)
	)
		refuse("ordering_malformed");
	const siblings = group
		.map(
			(row): OrderSibling =>
				Object.freeze({
					id: row.id,
					title: row.title,
					sortKey: row.sortKey,
					done: row.done,
				}),
		)
		.sort((a, b) => compare(a.sortKey, b.sortKey));
	if (
		siblings.some((row, i) => i > 0 && row.sortKey === siblings[i - 1].sortKey)
	)
		refuse("ordering_tied");
	if (siblings.length < 2) refuse("ordering_single");
	let parentTitle: string | null = null;
	if (selected.parentId !== null) {
		const parent = rows.find((row) => row.id === selected.parentId);
		if (!parent) refuse("ordering_stale");
		parentTitle = parent.title;
	}
	return Object.freeze({
		taskId,
		title: selected.title,
		workspaceId: task.workspaceId,
		listId,
		parentId: selected.parentId,
		parentTitle,
		siblings: Object.freeze(siblings),
		index: siblings.findIndex((row) => row.id === taskId),
		childCount: placement.childrenState.count,
		placementToken: placement.stateToken,
		listToken: list.stateToken,
	});
}

// Accepts digits only and never a value outside 1..total.
export function typePosition(
	current: string,
	text: string,
	total: number,
): string {
	let next = current;
	for (const digit of text) {
		if (!/^[0-9]$/.test(digit)) return current;
		const candidate = next + digit;
		if (candidate.startsWith("0") || Number(candidate) > total) return current;
		next = candidate;
	}
	return next;
}

export function parsePosition(text: string, total: number): number | null {
	if (!/^[1-9][0-9]*$/.test(text)) return null;
	const value = Number(text);
	return value <= total ? value : null;
}

// Positions are 1-based within the exact-parent group, completed rows included.
export function proposeOrdering(
	plan: OrderingPlan,
	position: number,
	generate: (a: string | null, b: string | null) => string = keyBetween,
): OrderProposal {
	const total = plan.siblings.length;
	if (!Number.isInteger(position) || position < 1 || position > total)
		refuse("invalid_input");
	if (position - 1 === plan.index) refuse("ordering_unchanged");
	const others = plan.siblings.filter((row) => row.id !== plan.taskId);
	const prev = others[position - 2] ?? null;
	const next = others[position - 1] ?? null;
	let key: string;
	try {
		key = generate(prev?.sortKey ?? null, next?.sortKey ?? null);
	} catch {
		refuse("ordering_key");
	}
	if (
		key.length > 256 ||
		!placementSortKeySchema.safeParse(key).success ||
		(prev !== null && !(prev.sortKey < key)) ||
		(next !== null && !(key < next.sortKey))
	)
		refuse("ordering_key");
	const body = Object.freeze(
		parseApiTaskPlacement({
			workspaceId: plan.workspaceId,
			listId: plan.listId,
			expectedState: plan.placementToken,
			targetListId: plan.listId,
			expectedTargetState: plan.listToken,
			sortKey: key,
			cascadeChildren: false,
			expectedChildrenState: null,
		}),
	);
	encodeTaskPlacementInput(body);
	const anchor = (row: OrderSibling | null): OrderAnchor | null =>
		row &&
		Object.freeze({ id: row.id, title: row.title, sortKey: row.sortKey });
	return {
		body,
		order: Object.freeze({
			from: plan.index + 1,
			to: position,
			total,
			key,
			after: anchor(prev),
			before: anchor(next),
			parentId: plan.parentId,
			parentTitle: plan.parentTitle,
			childCount: plan.childCount,
		}),
	};
}

// A bounded slice of the manual order around the task, with 1-based numbers.
export function orderWindow(
	plan: OrderingPlan,
	radius = 4,
): { start: number; items: readonly OrderSibling[] } {
	const start = Math.max(0, plan.index - radius);
	return {
		start,
		items: plan.siblings.slice(start, plan.index + radius + 1),
	};
}
