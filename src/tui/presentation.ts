import type { Locale } from "../domain/locale.ts";
import * as m from "../paraglide/messages.js";
import type { Entry } from "./api.ts";
import type { CommentsView, Review, TerminalState } from "./controller.ts";
import {
	type OrderAnchor,
	type OrderingPlan,
	orderWindow,
} from "./ordering.ts";
import type { RetryRecord } from "./recovery.ts";
import { safeText, type TextPart, type Tone, visibleCells } from "./render.ts";

export interface PresentationContext {
	locale: Locale;
	timezone: string;
	now: number;
	ascii?: boolean;
	columns?: number;
}

export function helpDetails(context: PresentationContext): string[] {
	const options = { locale: context.locale };
	return [
		m.tui_help_navigation({}, options),
		m.tui_help_writes({}, options),
		m.tui_help_exit({}, options),
		m.tui_footer({}, options),
		m.tui_help_presentation({}, options),
		m.tui_help_comments({}, options),
		m.tui_help_order({}, options),
		m.tui_symbols_help(
			{ open: context.ascii ? "( )" : "○", done: context.ascii ? "(x)" : "●" },
			options,
		),
	].flatMap((topic, index) => (index ? ["", topic] : [topic]));
}

export function exactPayloadLines(value: unknown): string[] {
	const json = JSON.stringify(value, null, 2);
	if (json === undefined) throw new TypeError("Unsupported payload");
	let quoted = false;
	let escaped = false;
	let result = "";
	for (const character of json) {
		const code = character.codePointAt(0) ?? 0;
		if (
			quoted &&
			!escaped &&
			(/\s/u.test(character) ||
				(code >= 127 && code <= 159) ||
				code === 0x61c ||
				code === 0x200e ||
				code === 0x200f ||
				(code >= 0x202a && code <= 0x202e) ||
				(code >= 0x2066 && code <= 0x2069))
		) {
			result += `\\u${code.toString(16).padStart(4, "0")}`;
			continue;
		}
		result += character;
		if (escaped) escaped = false;
		else if (quoted && character === "\\") escaped = true;
		else if (character === '"') quoted = !quoted;
	}
	return result.split("\n");
}

export function exactPayloadParts(value: unknown): TextPart[][] {
	return exactPayloadLines(value).map((line) => {
		const parts: TextPart[] = [];
		const tokens =
			/"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
		let offset = 0;
		for (const match of line.matchAll(tokens)) {
			const start = match.index;
			if (start > offset)
				parts.push({
					text: line.slice(offset, start),
					tone: "plain",
					preserveWhitespace: true,
				});
			const text = match[0];
			const end = start + text.length;
			const tone: Tone = text.startsWith('"')
				? /^\s*:/.test(line.slice(end))
					? "brand"
					: "success"
				: text === "null"
					? "info"
					: text === "true" || text === "false"
						? "recurring"
						: "warning";
			parts.push({ text, tone, ...(text === "null" ? { dim: true } : {}) });
			offset = end;
		}
		if (offset < line.length)
			parts.push({
				text: line.slice(offset),
				tone: "plain",
				preserveWhitespace: true,
			});
		return parts;
	});
}

export function reviewPayload(review: Review): RetryRecord {
	if (review.kind === "place")
		return {
			requestId: review.requestId,
			endpoint: `/api/v1/tasks/${encodeURIComponent(review.taskId)}/placement`,
			method: "PATCH",
			body: review.body,
		};
	if (review.kind === "update" || review.kind === "delete")
		return {
			requestId: review.requestId,
			endpoint: `/api/v1/tasks/${encodeURIComponent(review.taskId)}`,
			method: review.kind === "update" ? "PATCH" : "DELETE",
			body: review.body,
		};
	return {
		requestId: review.requestId,
		endpoint:
			review.kind === "create"
				? "/api/v1/tasks"
				: `/api/v1/tasks/${encodeURIComponent(review.task.id)}/complete`,
		body:
			review.kind === "create"
				? review.task
				: { listId: review.task.listId, expectedDueAt: review.task.dueAt },
	};
}

function dueText(
	data: Record<string, unknown>,
	context: PresentationContext,
): string | null {
	if (typeof data.dueAt !== "string") return null;
	const instant = new Date(data.dueAt);
	if (!Number.isFinite(instant.getTime())) return data.dueAt;
	return new Intl.DateTimeFormat(context.locale, {
		timeZone: context.timezone,
		dateStyle: "medium",
		...(data.dueAllDay === true ? {} : { timeStyle: "short" as const }),
	}).format(instant);
}

function overdue(
	data: Record<string, unknown>,
	context: PresentationContext,
): boolean {
	if (data.done === true || typeof data.dueAt !== "string") return false;
	if (data.dueAllDay === true) {
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: context.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		const sortable = (value: number) => {
			const parts = formatter.formatToParts(value);
			return ["year", "month", "day"]
				.map((type) => parts.find((part) => part.type === type)?.value)
				.join("-");
		};
		return sortable(Date.parse(data.dueAt)) < sortable(context.now);
	}
	return Date.parse(data.dueAt) < context.now;
}

function counts(value: unknown): number | undefined {
	return Array.isArray(value) ? value.length : undefined;
}

export function loadedTaskCounts(
	entries: readonly Entry[],
	context: PresentationContext,
): { loaded: number; open: number; done: number; overdue: number } {
	const tasks = entries.filter((entry) => typeof entry.data.done === "boolean");
	return {
		loaded: tasks.length,
		open: tasks.filter((entry) => !entry.data.done).length,
		done: tasks.filter((entry) => entry.data.done).length,
		overdue: tasks.filter((entry) => overdue(entry.data, context)).length,
	};
}

export function priorityLabel(value: number, locale: Locale): string {
	const options = { locale };
	return value === 3
		? m.tui_priority_high({}, options)
		: value === 2
			? m.tui_priority_medium({}, options)
			: value === 1
				? m.tui_priority_low({}, options)
				: m.tui_priority_none({}, options);
}

export function taskRow(
	entry: Entry,
	context: PresentationContext,
): {
	text: string;
	metadata: string;
	parts: TextPart[];
	metadataParts: TextPart[];
	tone: Tone;
} {
	const data = entry.data;
	if (typeof data.done !== "boolean" || typeof data.title !== "string")
		return {
			text: entry.label,
			metadata: "",
			parts: [{ text: entry.label, tone: "plain" }],
			metadataParts: [],
			tone: "plain",
		};
	const options = { locale: context.locale };
	const priority = typeof data.priority === "number" ? data.priority : 0;
	const level: Tone =
		priority === 3
			? "danger"
			: priority === 2
				? "warning"
				: priority === 1
					? "info"
					: "plain";
	const glyph = context.ascii
		? data.done
			? "(x)"
			: "( )"
		: data.done
			? "●"
			: "○";
	const parts: TextPart[] = [
		{ text: `${glyph} `, tone: data.done ? "success" : "plain" },
	];
	const wide = (context.columns ?? 100) >= 80;
	parts.push({
		text:
			priority > 0
				? wide
					? priorityLabel(priority, context.locale)
					: "!".repeat(priority)
				: "",
		tone: level,
		fieldWidth:
			(wide
				? Math.max(
						...[1, 2, 3].map((value) =>
							visibleCells(priorityLabel(value, context.locale)),
						),
					)
				: 3) + 1,
	});
	parts.push({ text: data.title, tone: "plain", dim: data.done });
	const metadataParts: TextPart[] = [];
	const due = dueText(data, context);
	if (due)
		metadataParts.push({
			text: `${overdue(data, context) ? m.due_overdue({}, options) : m.task_field_due({}, options)}: ${due}`,
			tone: overdue(data, context) ? "danger" : "info",
		});
	if (typeof data.quantity === "string")
		metadataParts.push({
			text: `${data.quantity}${typeof data.unit === "string" ? ` ${data.unit}` : ""}`,
			tone: "plain",
		});
	if (typeof data.rrule === "string" && data.rrule)
		metadataParts.push({
			text: `${context.ascii ? "R" : "↻"} ${m.recurrence_repeat({}, options)}`,
			tone: "recurring",
		});
	const assignees = counts(data.assigneeIds);
	const labels = counts(data.labelIds);
	if (assignees || labels)
		metadataParts.push({
			text: [
				assignees
					? `@${new Intl.NumberFormat(context.locale).format(assignees)}`
					: "",
				labels
					? `#${new Intl.NumberFormat(context.locale).format(labels)}`
					: "",
			]
				.filter(Boolean)
				.join(" "),
			tone: "plain",
		});
	return {
		text: parts
			.map(
				(part) =>
					part.text +
					" ".repeat(
						Math.max(0, (part.fieldWidth ?? 0) - visibleCells(part.text)),
					),
			)
			.join(""),
		metadata: metadataParts
			.map((part) => part.text)
			.join(context.ascii ? " | " : " · "),
		parts,
		metadataParts,
		tone: "plain",
	};
}

export function taskDetails(
	data: Record<string, unknown>,
	context: PresentationContext,
	includePriorityCode = true,
): string[] {
	const options = { locale: context.locale };
	const none = m.tui_empty_value({}, options);
	const lines: string[] = [];
	const pair = (label: string, value: unknown) => {
		if (value !== undefined)
			lines.push(
				`${label}: ${value === null || value === "" ? none : String(value)}`,
			);
	};
	pair(m.task_detail_title_field({}, options), data.title);
	if (typeof data.done === "boolean")
		pair(
			m.field_status({}, options),
			data.done ? m.status_done({}, options) : m.status_open({}, options),
		);
	pair(
		m.task_field_priority({}, options),
		data.priority === undefined
			? undefined
			: `${priorityLabel(Number(data.priority), context.locale)}${includePriorityCode ? ` (${data.priority})` : ""}`,
	);
	if (data.dueAt !== undefined)
		pair(m.task_field_due({}, options), dueText(data, context));
	if (data.dueAllDay !== undefined)
		pair(
			m.tui_all_day({}, options),
			data.dueAllDay ? m.tui_yes({}, options) : m.tui_no({}, options),
		);
	if (data.notes !== undefined) {
		lines.push(
			`${m.task_field_notes({}, options)}: ${typeof data.notes === "string" && data.notes ? "" : none}`,
		);
		if (typeof data.notes === "string" && data.notes)
			lines.push(
				...(typeof data.notes === "string" && data.notes
					? data.notes.split(/\r?\n/u)
					: []),
			);
	}
	pair(m.recurrence_repeat({}, options), data.rrule);
	pair(
		m.recurrence_relative_on({}, options),
		data.recurrenceRelative === undefined
			? undefined
			: data.recurrenceRelative
				? m.tui_yes({}, options)
				: m.tui_no({}, options),
	);
	pair(
		m.tui_quantity({}, options),
		data.quantity === undefined
			? undefined
			: data.quantity === null
				? null
				: `${data.quantity}${typeof data.unit === "string" ? ` ${data.unit}` : ""}`,
	);
	for (const [label, key] of [
		[m.field_assignees({}, options), "assigneeIds"],
		[m.task_field_labels({}, options), "labelIds"],
	] as const) {
		if (Array.isArray(data[key]))
			pair(label, data[key].length ? data[key].join(", ") : none);
	}
	for (const [key, label] of [
		["id", m.tui_task_id({}, options)],
		["taskId", m.tui_task_id({}, options)],
		["listId", m.tui_list_id({}, options)],
		["workspaceId", m.tui_workspace_id({}, options)],
		["parentId", m.tui_parent_id({}, options)],
	] as const)
		pair(label, data[key]);
	if (data.expectedDueAt !== undefined)
		pair(
			m.task_field_due({}, options),
			dueText({ dueAt: data.expectedDueAt }, context),
		);

	return lines;
}

export function entryDetails(
	entry: Entry,
	context: PresentationContext,
): string[] {
	if (typeof entry.data.title === "string" && "dueAt" in entry.data)
		return taskDetails(entry.data, context);
	return Object.entries(entry.data).map(
		([key, value]) =>
			`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
	);
}

function instantText(value: string, context: PresentationContext): string {
	const instant = new Date(value);
	if (!Number.isFinite(instant.getTime())) return safeText(value);
	return new Intl.DateTimeFormat(context.locale, {
		timeZone: context.timezone,
		dateStyle: "medium",
		timeStyle: "short",
	}).format(instant);
}

// Read-only comment page. Author text is shown only when the server supplied it.
export type CommentsPane = Pick<
	CommentsView,
	"taskId" | "title" | "items" | "nextCursor"
> & { status: TerminalState["status"]; error: string | null };

export function commentParts(
	view: CommentsPane,
	context: PresentationContext,
	exact = false,
): TextPart[][] {
	const options = { locale: context.locale };
	const line = (text: string, part: Partial<TextPart> = {}): TextPart[] => [
		{ text, tone: "plain", ...part },
	];
	// An empty list is only "no comments" after a successful empty read.
	if (!view.items.length && view.status === "loading")
		return [line(m.app_loading({}, options), { dim: true })];
	if (!view.items.length && view.status === "error")
		return [
			line(
				m.tui_error(
					{ code: safeText(view.error ?? "request_failed") },
					options,
				),
				{
					tone: "danger",
				},
			),
		];
	if (exact)
		return exactPayloadParts({
			comments: view.items,
			nextCursor: view.nextCursor,
		});
	const lines: TextPart[][] = [
		line(m.tui_comments_task({ title: safeText(view.title) }, options), {
			bold: true,
		}),
		line(`${m.tui_task_id({}, options)}: ${safeText(view.taskId)}`, {
			tone: "info",
			dim: true,
		}),
	];
	if (!view.items.length)
		return view.status === "empty"
			? [...lines, [], line(m.tui_comments_empty({}, options))]
			: lines;
	for (const comment of view.items) {
		const imported = comment.historicalAuthorKind;
		lines.push(
			[],
			line(
				m.tui_comment_created(
					{ time: instantText(comment.createdAt, context) },
					options,
				),
				{ tone: "brand", bold: true },
			),
		);
		if (comment.editedAt)
			lines.push(
				line(
					m.tui_comment_edited(
						{ time: instantText(comment.editedAt, context) },
						options,
					),
					{ tone: "info" },
				),
			);
		if (comment.authorId !== null)
			lines.push(
				line(m.tui_comment_author({ id: safeText(comment.authorId) }, options)),
			);
		if (imported !== null)
			lines.push(
				line(
					imported === "source_claim" &&
						comment.historicalAuthorName &&
						!comment.provenanceRedactedAt
						? m.tui_comment_imported_author(
								{ name: safeText(comment.historicalAuthorName) },
								options,
							)
						: m.tui_comment_imported_unknown({}, options),
					{ tone: "warning" },
				),
			);
		if (comment.authorId === null && imported === null)
			lines.push(line(m.tui_comment_no_author({}, options), { dim: true }));
		if (comment.importedAt)
			lines.push(
				line(
					m.tui_comment_imported_at(
						{ time: instantText(comment.importedAt, context) },
						options,
					),
					{ tone: "warning", dim: true },
				),
			);
		if (comment.provenanceRedactedAt)
			lines.push(
				line(
					m.tui_comment_redacted(
						{ time: instantText(comment.provenanceRedactedAt, context) },
						options,
					),
					{ tone: "warning", dim: true },
				),
			);
		lines.push(
			line(
				`${m.tui_comment_id({ id: safeText(comment.commentId) }, options)}`,
				{
					tone: "info",
					dim: true,
				},
			),
		);
		for (const body of comment.body.split(/\r\n|\r|\n/u))
			lines.push(line(`  ${safeText(body)}`));
	}
	return lines;
}

export function commentDetails(
	view: CommentsPane,
	context: PresentationContext,
	exact = false,
): string[] {
	return commentParts(view, context, exact).map((parts) =>
		parts.map((part) => part.text).join(""),
	);
}

function groupLine(
	parentId: string | null,
	parentTitle: string | null,
	options: { locale: Locale },
): string {
	return parentId === null
		? m.tui_order_group_root({}, options)
		: m.tui_order_group_subtasks(
				{ parent: safeText(parentTitle ?? parentId) },
				options,
			);
}

// Manual sibling order around the task; browse pages stay ID ordered.
export function orderDetails(
	plan: OrderingPlan,
	position: string,
	context: PresentationContext,
): string[] {
	const options = { locale: context.locale };
	const number = new Intl.NumberFormat(context.locale);
	const total = plan.siblings.length;
	const { start, items } = orderWindow(plan);
	// The prompt and typed echo lead so the first narrow frame shows the field;
	// typing never scrolls, and every sibling and note stays below.
	return [
		m.tui_order_position_prompt({ total: number.format(total) }, options),
		`> ${position}`,
		"",
		m.tui_order_title({ title: safeText(plan.title) }, options),
		groupLine(plan.parentId, plan.parentTitle, options),
		...(plan.childCount > 0
			? [m.tui_order_children_stay({ count: plan.childCount }, options)]
			: []),
		m.tui_order_current(
			{
				position: number.format(plan.index + 1),
				total: number.format(total),
			},
			options,
		),
		"",
		...items.map((sibling, offset) => {
			const glyph = context.ascii
				? sibling.done
					? "(x)"
					: "( )"
				: sibling.done
					? "●"
					: "○";
			return `${start + offset === plan.index ? ">" : " "} ${number.format(start + offset + 1)}. ${glyph} ${safeText(sibling.title)}`;
		}),
		"",
		m.tui_order_browse_note({}, options),
		m.tui_order_readonly({}, options),
	];
}

function placeLines(
	review: Extract<Review, { kind: "place" }>,
	context: PresentationContext,
): string[] {
	const options = { locale: context.locale };
	const number = new Intl.NumberFormat(context.locale);
	const order = review.order;
	const anchor = (value: OrderAnchor) =>
		`${safeText(value.title)} (${safeText(value.id)})`;
	return [
		`${m.tui_task_id({}, options)}: ${review.taskId}`,
		groupLine(order.parentId, order.parentTitle, options),
		m.tui_order_move(
			{
				from: number.format(order.from),
				to: number.format(order.to),
				total: number.format(order.total),
			},
			options,
		),
		order.after
			? m.tui_order_after({ task: anchor(order.after) }, options)
			: m.tui_order_start({}, options),
		order.before
			? m.tui_order_before({ task: anchor(order.before) }, options)
			: m.tui_order_end({}, options),
		m.tui_order_key({ key: order.key }, options),
		...(order.childCount > 0
			? [m.tui_order_children_stay({ count: order.childCount }, options)]
			: []),
		m.tui_order_not_atomic({}, options),
	];
}

export function reviewDetails(
	review: Review,
	context: PresentationContext,
	exact: boolean,
): string[] {
	const options = { locale: context.locale };
	const payload = reviewPayload(review);
	const body = payload.body as Record<string, unknown>;
	return [
		...(review.uncertain ? [m.tui_uncertain({}, options)] : []),
		...(exact
			? [
					`${m.tui_request_id({}, options)}: ${payload.requestId}`,
					`${payload.method ?? "POST"} ${payload.endpoint}`,
				]
			: []),
		...(review.kind === "delete"
			? [
					m.tui_delete_scope({}, options),
					review.body.cascadeChildren
						? m.tui_delete_cascade({}, options)
						: m.tui_delete_no_children({}, options),
					m.tui_delete_observed_count(
						{
							count: new Intl.NumberFormat(context.locale).format(
								review.body.expectedChildrenState.count,
							),
						},
						options,
					),
				]
			: []),
		...(review.kind === "complete" && review.recurring
			? [m.tui_review_recurring({}, options)]
			: []),
		...(!exact && review.list && review.list.id === body.listId
			? [`${m.field_list({}, options)}: ${review.list.name}`]
			: []),
		...(exact
			? exactPayloadLines(payload)
			: [
					...(review.kind !== "create" ? [review.title] : []),
					...(review.kind === "place"
						? placeLines(review, context)
						: taskDetails(
								review.kind === "update"
									? {
											...(body.patch as Record<string, unknown>),
											listId: body.listId,
											expectedState: body.expectedState,
										}
									: body,
								review.kind === "create"
									? { ...context, timezone: review.timezone }
									: context,
								false,
							)),
				]),
		...(!exact
			? [
					"",
					`${m.tui_request_id({}, options)}: ${payload.requestId}`,
					`${payload.method ?? "POST"} ${payload.endpoint}`,
				]
			: []),
	];
}

export function reviewParts(
	review: Review,
	context: PresentationContext,
	exact = false,
): TextPart[][] {
	if (exact) {
		const payloadParts = exactPayloadParts(reviewPayload(review));
		const header = reviewDetails(review, context, true).slice(
			0,
			-payloadParts.length,
		);
		return [
			...header.map((text): TextPart[] => [{ text, tone: "plain" }]),
			...payloadParts,
		];
	}
	const options = { locale: context.locale };
	const payload = reviewPayload(review);
	const methodLine = `${payload.method ?? "POST"} ${payload.endpoint}`;
	const body = payload.body as Record<string, unknown>;
	const displayed =
		review.kind === "update" ? (body.patch as Record<string, unknown>) : body;
	const caveat = m.tui_order_not_atomic({}, options);
	const primary = [
		m.task_detail_title_field({}, options),
		m.task_field_due({}, options),
	];
	const labels = [
		...primary,
		m.field_list({}, options),
		m.task_field_priority({}, options),
		m.tui_all_day({}, options),
		m.task_field_notes({}, options),
		m.field_assignees({}, options),
		m.task_field_labels({}, options),
	];
	const metadata = [
		m.tui_request_id({}, options),
		m.tui_task_id({}, options),
		m.tui_list_id({}, options),
		m.tui_workspace_id({}, options),
		m.tui_parent_id({}, options),
	];
	return reviewDetails(review, context, false).map((line) => {
		if (review.kind !== "create" && line === review.title)
			return [{ text: line, tone: "plain", bold: true }];
		if (
			metadata.some((label) => line.startsWith(`${label}: `)) ||
			line === methodLine
		)
			return [{ text: line, tone: "plain", dim: true }];
		const label = labels.find((value) => line.startsWith(`${value}: `));
		if (!label)
			return [
				{
					text: line,
					tone:
						review.kind === "place" && line === caveat ? "warning" : "plain",
					bold: review.kind !== "create" && line === review.title,
				},
			];
		const value = line.slice(label.length + 2);
		const unset =
			label === m.task_field_notes({}, options)
				? displayed.notes === null || displayed.notes === ""
				: label === m.task_field_due({}, options)
					? displayed.dueAt === null
					: label === m.task_field_priority({}, options)
						? displayed.priority === 0
						: label === m.field_assignees({}, options)
							? Array.isArray(displayed.assigneeIds) &&
								displayed.assigneeIds.length === 0
							: label === m.task_field_labels({}, options)
								? Array.isArray(displayed.labelIds) &&
									displayed.labelIds.length === 0
								: false;
		return [
			{ text: `${label}: `, tone: "brand", bold: true },
			{
				text: value,
				tone: "plain",
				bold: primary.includes(label) && !unset,
				dim: unset,
			},
		];
	});
}
