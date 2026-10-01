import { z } from "zod";
import { panelsSchema } from "../dashboard.ts";
import { isAutoLockMinutes } from "../e2e/auto-lock.ts";
import { MAX_REPEAT_EVERY_MIN, MAX_REPEATS_CAP } from "../escalation-policy.ts";
import { levelForPoints } from "../karma.ts";
import { LOCALES } from "../locale.ts";
import { parseRule } from "../recurrence.ts";
import { templateContentSchema } from "../template.ts";
import {
	type FilterGroup,
	filterGroupSchema,
	viewDisplaySchema,
} from "../view-filter.ts";
import type { PortableExportV1, PortableJson } from "./v1.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_ARRAY_ITEMS = 50_000;
const MAX_VISITED_VALUES = 2_000_000;
const MAX_NESTING = 32;
const string = z.string();
const id = string;
const nullableString = string.nullable();
const integer = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const nonnegative = integer.min(0);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const clock = string.regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const kind = z.enum(["tasks", "shopping", "checklist", "project", "habits"]);
const day = string.regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
}, "Invalid calendar day");
// Exported timestamps come from Date.toISOString(), including extended years.
const timestamp = string.refine((value) => {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "Expected an exported ISO timestamp");
const dateBound = z.union([day, timestamp]);
const repeatEveryMin = integer.min(1).max(MAX_REPEAT_EVERY_MIN).nullable();
const maxRepeats = nonnegative.max(MAX_REPEATS_CAP).nullable();
const recurrence = string
	.refine((value) => {
		try {
			parseRule(value);
			return true;
		} catch {
			return false;
		}
	}, "Invalid recurrence rule")
	.nullable();

function unchanged(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (
		!left ||
		!right ||
		typeof left !== "object" ||
		typeof right !== "object" ||
		Array.isArray(left) !== Array.isArray(right)
	)
		return false;
	if (Array.isArray(left) && Array.isArray(right))
		return (
			left.length === right.length &&
			left.every((value, index) => unchanged(value, right[index]))
		);
	const l = left as Record<string, unknown>;
	const r = right as Record<string, unknown>;
	const keys = Object.keys(l);
	return (
		keys.length === Object.keys(r).length &&
		keys.every((key) => Object.hasOwn(r, key) && unchanged(l[key], r[key]))
	);
}

// Existing domain schemas may strip unknown keys. Import must reject those
// inputs, not silently discard fields or insert defaults into the document.
function exactDomain(schema: z.ZodType): z.ZodType<PortableJson> {
	return z.custom<PortableJson>((value: unknown) => {
		const parsed = schema.safeParse(value);
		return parsed.success && unchanged(value, parsed.data);
	}, "Invalid or unsupported domain content");
}

const condition = z.union([
	z.strictObject({
		field: z.literal("done"),
		operator: z.literal("is"),
		value: z.boolean(),
	}),
	z.strictObject({
		field: z.literal("due"),
		operator: z.literal("is"),
		value: z.enum(["none", "overdue", "today", "next7"]),
	}),
	z.strictObject({
		field: z.literal("due"),
		operator: z.enum(["before", "after"]),
		value: dateBound,
	}),
	z.strictObject({
		field: z.literal("priority"),
		operator: z.enum(["eq", "gte", "lte"]),
		value: z.number().finite(),
	}),
	z.strictObject({
		field: z.literal("kind"),
		operator: z.literal("eq"),
		value: kind,
	}),
	z.strictObject({
		field: z.literal("kind"),
		operator: z.literal("in"),
		value: z.array(kind).max(MAX_ARRAY_ITEMS),
	}),
	z.strictObject({
		field: z.literal("list"),
		operator: z.literal("eq"),
		value: string,
	}),
	z.strictObject({
		field: z.literal("folder"),
		operator: z.literal("eq"),
		value: nullableString,
	}),
	z.strictObject({
		field: z.enum(["list", "folder"]),
		operator: z.literal("in"),
		value: z.array(string).max(MAX_ARRAY_ITEMS),
	}),
	z.strictObject({
		field: z.enum(["label", "assignee"]),
		operator: z.enum(["includes", "excludes"]),
		value: string,
	}),
]);
const filter: z.ZodType<FilterGroup> = z
	.lazy(() =>
		z.strictObject({
			op: z.enum(["and", "or"]),
			conditions: z.array(z.union([condition, filter])).max(50),
		}),
	)
	.refine(
		(value) => filterGroupSchema.safeParse(value).success,
		"Invalid filter bounds",
	);
const strictFilter = exactDomain(filter);
const boundedTemplate = exactDomain(
	templateContentSchema.refine((content) => {
		const tasks = content.kind === "list" ? content.tasks : [content.task];
		return (
			tasks.length <= MAX_ARRAY_ITEMS &&
			tasks.every((task) => (task.subtasks?.length ?? 0) <= MAX_ARRAY_ITEMS)
		);
	}, "Template array limit exceeded"),
);
const strictPanels = exactDomain(panelsSchema).refine((value) => {
	if (!Array.isArray(value)) return false;
	for (const panel of value) {
		if (!panel || typeof panel !== "object" || Array.isArray(panel))
			return false;
		const source = panel.source;
		if (
			source &&
			typeof source === "object" &&
			!Array.isArray(source) &&
			source.kind === "inline" &&
			!strictFilter.safeParse(source.filter).success
		)
			return false;
	}
	return true;
}, "Invalid inline panel filter");

const preferences = z.strictObject({
	id,
	keymap: z
		.record(string.max(64), z.array(z.array(string.max(24)).max(4)).max(4))
		.refine((value) => Object.keys(value).length <= 100),
	keymapProfile: z.enum(["default", "vim"]),
	homeViewRef: string.max(200).nullable(),
	pinnedViews: z.array(string.max(64)).max(200),
	karmaGoals: z
		.strictObject({
			daily: nonnegative.max(1000),
			weekly: nonnegative.max(1000),
		})
		.nullable(),
	vacation: z
		.strictObject({ active: z.boolean(), until: day.optional() })
		.nullable(),
	focus: z
		.strictObject({
			workMin: integer.min(1).max(180),
			breakMin: integer.min(1).max(180),
			longBreakMin: integer.min(1).max(180),
			roundsPerLongBreak: integer.min(1).max(12),
			autoCycle: z.boolean(),
		})
		.nullable(),
	timezone: string.max(100).refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}),
	quietHours: z
		.strictObject({ start: clock, end: clock })
		.refine((value) => value.start !== value.end)
		.nullable(),
	escalationDefaults: z
		.strictObject({
			repeatEveryMin,
			maxRepeats,
			fallbackUserId: string.max(200).nullable(),
		})
		.nullable(),
	locale: z.enum(LOCALES).nullable(),
	theme: z.enum(["light", "dark"]).nullable(),
	e2eAutoLockMinutes: z.custom<number>(isAutoLockMinutes).nullable(),
	createdAt: timestamp,
	updatedAt: timestamp,
});

const rows = {
	principals: z.strictObject({ id, name: string }),
	workspaces: z.strictObject({
		id,
		name: string,
		ownerId: id,
		kind: z.enum(["personal", "shared"]),
	}),
	memberships: z.strictObject({
		id,
		userId: id,
		workspaceId: id,
		role: z.enum(["owner", "admin", "member", "viewer"]),
	}),
	folders: z.strictObject({
		id,
		workspaceId: id,
		name: string,
		sortKey: string,
	}),
	lists: z.strictObject({
		id,
		workspaceId: id,
		ownerId: id,
		title: string,
		kind,
		icon: nullableString,
		folderId: id.nullable(),
		sortKey: string,
		completedDisplay: z.enum(["sink", "keep", "hide"]),
	}),
	tasks: z.strictObject({
		id,
		listId: id,
		title: string,
		done: z.boolean(),
		notes: nullableString,
		dueAt: timestamp.nullable(),
		dueAllDay: z.boolean(),
		priority: integer.min(-32768).max(32767),
		completedAt: timestamp.nullable(),
		sortKey: string,
		parentId: id.nullable(),
		quantity: nullableString,
		unit: nullableString,
		category: nullableString,
		rrule: recurrence,
		recurrenceRelative: z.boolean(),
		reminderTime: clock.nullable(),
		repeatEveryMin,
		maxRepeats,
		fallbackUserId: id.nullable(),
		urgent: z.boolean(),
	}),
	labels: z.strictObject({ id, workspaceId: id, name: string, color: string }),
	taskLabels: z.strictObject({ id, taskId: id, labelId: id }),
	templates: z
		.strictObject({
			id,
			workspaceId: id,
			kind: z.enum(["list", "task"]),
			name: string,
			icon: nullableString,
			content: boundedTemplate,
			createdBy: id,
		})
		.refine(
			(row) =>
				row.content !== null &&
				typeof row.content === "object" &&
				!Array.isArray(row.content) &&
				row.content.kind === row.kind,
			"Template kind mismatch",
		),
	assignments: z.strictObject({ id, taskId: id, userId: id }),
	comments: z.strictObject({
		id,
		taskId: id,
		authorId: id,
		body: string,
		createdAt: timestamp,
		editedAt: timestamp.nullable(),
	}),
	habitLogs: z
		.strictObject({
			id,
			habitId: id,
			date: day,
			status: z.enum(["done", "skipped"]),
			karmaDelta: nonnegative,
			completedAt: timestamp.nullable(),
			createdAt: timestamp,
		})
		.refine(
			(row) =>
				row.status === "skipped"
					? row.karmaDelta === 0 && row.completedAt === null
					: row.completedAt !== null,
			"Inconsistent habit state",
		),
	views: z.strictObject({
		id,
		ownerId: id,
		workspaceId: id.nullable(),
		name: string,
		icon: nullableString,
		scope: z.enum(["personal", "workspace"]),
		filter: strictFilter,
		display: exactDomain(viewDisplaySchema),
		sortKey: string,
		createdAt: timestamp,
		updatedAt: timestamp,
	}),
	dashboards: z.strictObject({
		id,
		ownerId: id,
		workspaceId: id.nullable(),
		scope: z.enum(["personal", "workspace"]),
		name: string,
		icon: nullableString,
		panels: strictPanels,
		sortKey: string,
		createdAt: timestamp,
		updatedAt: timestamp,
	}),
	userPrefs: preferences,
	focusSessions: z
		.strictObject({
			id,
			userId: id,
			taskId: id.nullable(),
			kind: z.enum(["work", "break"]),
			startedAt: timestamp,
			endedAt: timestamp,
			durationSec: integer.min(1).max(86400),
			createdAt: timestamp,
		})
		.refine(
			(row) =>
				Date.parse(row.endedAt) >= Date.parse(row.startedAt) &&
				row.durationSec <=
					Math.ceil(
						(Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000,
					) +
						1,
			"Invalid focus interval",
		),
	karma: z
		.strictObject({
			userId: id,
			points: nonnegative,
			level: integer.min(1),
			updatedAt: timestamp,
		})
		.refine(
			(row) => row.level === levelForPoints(row.points),
			"Inconsistent Karma level",
		),
	karmaEvents: z.strictObject({
		id,
		userId: id,
		date: day,
		delta: integer,
		reason: string,
		createdAt: timestamp,
	}),
	attachments: z.strictObject({
		id,
		workspaceId: id,
		parentKind: z.enum(["task", "comment", "list"]),
		parentId: id,
		keyVersion: integer.min(1),
		declaredBytes: bytes,
		observedBytes: bytes.nullable(),
		ciphertextSha256: string.regex(/^[a-f0-9]{64}$/).nullable(),
		thumbnailDeclaredBytes: bytes.nullable(),
		thumbnailObservedBytes: bytes.nullable(),
		thumbnailCiphertextSha256: string.regex(/^[a-f0-9]{64}$/).nullable(),
		uploadedBy: id,
		createdAt: timestamp,
		committedAt: timestamp.nullable(),
	}),
};

const documentSchema = z.strictObject({
	format: z.literal("ditero"),
	schemaVersion: z.literal(1),
	exportedAt: timestamp,
	sourceUserId: id,
	boundaries: z.strictObject({
		attachmentContent: z.literal("excluded"),
		encryptionKeys: z.literal("excluded"),
		credentials: z.literal("excluded"),
		managedAccounts: z.literal("excluded"),
		restoreSupported: z.literal(false),
		taskHistory: z.literal("current-state-and-habit-logs"),
	}),
	data: z.strictObject({
		principals: z.array(rows.principals),
		workspaces: z.array(rows.workspaces),
		memberships: z.array(rows.memberships),
		folders: z.array(rows.folders),
		lists: z.array(rows.lists),
		tasks: z.array(rows.tasks),
		labels: z.array(rows.labels),
		taskLabels: z.array(rows.taskLabels),
		templates: z.array(rows.templates),
		assignments: z.array(rows.assignments),
		comments: z.array(rows.comments),
		habitLogs: z.array(rows.habitLogs),
		views: z.array(rows.views),
		dashboards: z.array(rows.dashboards),
		userPrefs: z.array(rows.userPrefs),
		focusSessions: z.array(rows.focusSessions),
		karma: z.array(rows.karma),
		karmaEvents: z.array(rows.karmaEvents),
		attachments: z.array(rows.attachments),
	}),
}) satisfies z.ZodType<PortableExportV1>;

const validationMessages = {
	"invalid-json": "Invalid portable export JSON",
	"invalid-export": "Invalid portable export structure",
	"byte-limit": "Portable export exceeds byte limit",
	"row-limit": "Portable export exceeds row limit",
	"nesting-limit": "Portable export exceeds nesting limit",
	"array-limit": "Portable export exceeds array limit",
	"node-limit": "Portable export exceeds node limit",
	"non-finite-number": "Portable export contains a non-finite number",
	"invalid-text": "Portable export contains unsupported text",
} as const;

export class PortableExportValidationError extends Error {
	constructor(readonly code: keyof typeof validationMessages) {
		super(validationMessages[code]);
		this.name = "PortableExportValidationError";
	}
}

function checkText(value: string): void {
	if (value.includes("\u0000") || !value.isWellFormed())
		throw new PortableExportValidationError("invalid-text");
}

function* childValues(value: object): Generator<unknown> {
	if (Array.isArray(value)) yield* value;
	else
		for (const key in value) {
			if (Object.hasOwn(value, key)) {
				checkText(key);
				yield (value as Record<string, unknown>)[key];
			}
		}
}

export function parsePortableExportV1(input: string): PortableExportV1 {
	let byteLength = 0;
	for (const character of input) {
		const point = character.codePointAt(0) ?? 0;
		byteLength +=
			point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (byteLength > MAX_BYTES)
			throw new PortableExportValidationError("byte-limit");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input);
	} catch {
		throw new PortableExportValidationError("invalid-json");
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		"data" in parsed &&
		parsed.data &&
		typeof parsed.data === "object"
	) {
		let count = 0;
		for (const collection of childValues(parsed.data)) {
			if (Array.isArray(collection)) count += collection.length;
			if (count > MAX_ROWS)
				throw new PortableExportValidationError("row-limit");
		}
	}
	// Iterator frames bound traversal memory by depth, even for wide arrays.
	// This runs before all recursive schemas and structural comparisons.
	const pending: { iterator: Iterator<unknown>; depth: number }[] = [
		{ iterator: [parsed][Symbol.iterator](), depth: 0 },
	];
	let visited = 0;
	while (pending.length) {
		const frame = pending[pending.length - 1];
		if (!frame) break;
		const next = frame.iterator.next();
		if (next.done) {
			pending.pop();
			continue;
		}
		visited++;
		if (visited > MAX_VISITED_VALUES)
			throw new PortableExportValidationError("node-limit");
		if (Array.isArray(next.value) && next.value.length > MAX_ARRAY_ITEMS)
			throw new PortableExportValidationError("array-limit");
		if (frame.depth > MAX_NESTING)
			throw new PortableExportValidationError("nesting-limit");
		if (typeof next.value === "number" && !Number.isFinite(next.value))
			throw new PortableExportValidationError("non-finite-number");
		if (typeof next.value === "string") checkText(next.value);
		if (next.value && typeof next.value === "object")
			pending.push({
				iterator: childValues(next.value),
				depth: frame.depth + 1,
			});
	}
	const validated = documentSchema.safeParse(parsed);
	if (!validated.success || !unchanged(parsed, validated.data))
		throw new PortableExportValidationError("invalid-export");
	return validated.data;
}
