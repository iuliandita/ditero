// Pure template model: snapshot a list/task into a timeless content blob, and
// instantiate a content blob back into concrete rows. Both halves are pure so
// the Zero mutators (server) and the create-from-template UI (client) share
// them. `instantiate` takes injected id/key generators — the mutator supplies a
// deterministic seeded id generator so client and server converge; tests can
// pass `crypto.randomUUID` to prove ids are fresh per call.
import { z } from "zod";
import type { ListKind } from "./icon-map.ts";

export type TemplateTask = {
	title: string;
	notes?: string;
	priority?: number;
	quantity?: string;
	unit?: string;
	category?: string;
	subtasks?: Array<Omit<TemplateTask, "subtasks">>;
};

export type TemplateContent =
	| { kind: "list"; listKind: ListKind; icon?: string; tasks: TemplateTask[] }
	| { kind: "task"; task: TemplateTask };

// Subtasks are exactly one level deep (domain model: "subtasks one level",
// enforced by task.create) — deliberately non-recursive; do not turn this into
// z.lazy recursion.
const subtaskSchema = z.object({
	title: z.string().min(1),
	notes: z.string().optional(),
	priority: z.number().optional(),
	quantity: z.string().optional(),
	unit: z.string().optional(),
	category: z.string().optional(),
});
const taskSchema = subtaskSchema.extend({
	subtasks: z.array(subtaskSchema).optional(),
});
// Hardcoded (not the drizzle enum) to keep drizzle's runtime out of this
// client+server module, matching icon-map.ts / mutators.ts; `satisfies` ties it
// to ListKind so a typo or removed kind fails to compile.
const LIST_KINDS = [
	"tasks",
	"shopping",
	"checklist",
	"project",
	"habits",
] as const satisfies readonly ListKind[];
const listKind = z.enum(LIST_KINDS);

export const templateContentSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("list"),
		listKind,
		icon: z.string().optional(),
		tasks: z.array(taskSchema),
	}),
	z.object({ kind: z.literal("task"), task: taskSchema }),
]);

// --- snapshot (row -> timeless content) ---

// Accepts a task/list row; the timeful fields (id/done/completedAt/dueAt/
// sortKey) are permitted but ignored — a snapshot is timeless. Nullish matches
// the DB shape (nullable columns) and is treated as absent.
type Nullish<T> = T | null | undefined;
type SnapshotTaskRow = {
	title: string;
	notes?: Nullish<string>;
	priority?: Nullish<number>;
	quantity?: Nullish<string>;
	unit?: Nullish<string>;
	category?: Nullish<string>;
	subtasks?: SnapshotTaskRow[];
	// ignored, accepted so real rows type-check without stripping first
	id?: unknown;
	done?: unknown;
	completedAt?: unknown;
	dueAt?: unknown;
	sortKey?: unknown;
};

function stripTask(t: SnapshotTaskRow): TemplateTask {
	const out: TemplateTask = { title: t.title };
	if (t.notes != null) out.notes = t.notes;
	// priority 0 is the "none" default; keep templates free of it.
	if (t.priority != null && t.priority !== 0) out.priority = t.priority;
	if (t.quantity != null) out.quantity = t.quantity;
	if (t.unit != null) out.unit = t.unit;
	if (t.category != null) out.category = t.category;
	return out;
}

function stripTaskWithSubtasks(t: SnapshotTaskRow): TemplateTask {
	const out = stripTask(t);
	if (t.subtasks && t.subtasks.length > 0)
		out.subtasks = t.subtasks.map(stripTask);
	return out;
}

export function snapshotList(
	list: { kind: ListKind; icon?: Nullish<string> },
	tasks: SnapshotTaskRow[],
): TemplateContent {
	const content: Extract<TemplateContent, { kind: "list" }> = {
		kind: "list",
		listKind: list.kind,
		tasks: tasks.map(stripTaskWithSubtasks),
	};
	if (list.icon != null) content.icon = list.icon;
	return content;
}

export function snapshotTask(
	task: SnapshotTaskRow,
	subtasks: SnapshotTaskRow[],
): TemplateContent {
	const t = stripTask(task);
	if (subtasks.length > 0) t.subtasks = subtasks.map(stripTask);
	return { kind: "task", task: t };
}

// --- instantiate (content -> concrete rows) ---

export type InstantiatedList = {
	id: string;
	title: string;
	kind: ListKind;
	sortKey: string;
	icon?: string;
};

export type InstantiatedTask = {
	id: string;
	listId: string;
	title: string;
	sortKey: string;
	done: false;
	parentId?: string;
	notes?: string;
	priority?: number;
	quantity?: string;
	unit?: string;
	category?: string;
};

export type Instantiated = {
	list?: InstantiatedList;
	tasks: InstantiatedTask[];
};

export type InstantiateOpts = {
	// Root sort key: the list's sortKey for a list template, or the root task's
	// sortKey for a task template. Both come from the client, like list.create.
	sortKey: string;
	listId?: string; // target list id — required for task templates
	title?: string; // list title (from the template name) — for list templates
};

type KeyGen = (prev: string | null, next: string | null) => string;

function expandTask(
	src: TemplateTask,
	id: string,
	listId: string,
	sortKey: string,
	parentId?: string,
): InstantiatedTask {
	const t: InstantiatedTask = {
		id,
		listId,
		title: src.title,
		sortKey,
		done: false,
	};
	if (parentId != null) t.parentId = parentId;
	if (src.notes != null) t.notes = src.notes;
	if (src.priority != null) t.priority = src.priority;
	if (src.quantity != null) t.quantity = src.quantity;
	if (src.unit != null) t.unit = src.unit;
	if (src.category != null) t.category = src.category;
	return t;
}

export function instantiate(
	content: TemplateContent,
	idGen: () => string,
	keyGen: KeyGen,
	opts: InstantiateOpts,
): Instantiated {
	const tasks: InstantiatedTask[] = [];

	// Sequential sibling keys chained off the previous one, strictly ascending.
	const emitSubtasks = (
		subs: Array<Omit<TemplateTask, "subtasks">> | undefined,
		listId: string,
		parentId: string,
	) => {
		let prev: string | null = null;
		for (const sub of subs ?? []) {
			const key = keyGen(prev, null);
			prev = key;
			tasks.push(expandTask(sub, idGen(), listId, key, parentId));
		}
	};

	if (content.kind === "list") {
		const listId = idGen();
		const list: InstantiatedList = {
			id: listId,
			title: opts.title ?? "",
			kind: content.listKind,
			sortKey: opts.sortKey,
		};
		if (content.icon != null) list.icon = content.icon;
		let prev: string | null = null;
		for (const src of content.tasks) {
			const key = keyGen(prev, null);
			prev = key;
			const id = idGen();
			tasks.push(expandTask(src, id, listId, key));
			emitSubtasks(src.subtasks, listId, id);
		}
		return { list, tasks };
	}

	const { listId } = opts;
	if (listId == null)
		throw new Error("instantiate: task content requires opts.listId");
	const rootId = idGen();
	tasks.push(expandTask(content.task, rootId, listId, opts.sortKey));
	emitSubtasks(content.task.subtasks, listId, rootId);
	return { tasks };
}

// --- starter templates (code constants, not seeded DB rows) ---

export const STARTER_TEMPLATES: TemplateContent[] = [
	{
		kind: "list",
		listKind: "shopping",
		icon: "shopping-cart",
		tasks: [
			{ title: "Milk", quantity: "1", unit: "gal", category: "Dairy" },
			{ title: "Eggs", quantity: "12", category: "Dairy" },
			{ title: "Bread", quantity: "1", category: "Bakery" },
			{ title: "Bananas", quantity: "1", unit: "bunch", category: "Produce" },
			{ title: "Spinach", quantity: "1", unit: "bag", category: "Produce" },
			{ title: "Chicken breast", quantity: "2", unit: "lb", category: "Meat" },
			{ title: "Rice", quantity: "1", unit: "bag", category: "Pantry" },
			{ title: "Coffee", quantity: "1", category: "Pantry" },
		],
	},
	{
		kind: "list",
		listKind: "checklist",
		icon: "plane",
		tasks: [
			{ title: "Passport / ID" },
			{ title: "Phone charger" },
			{ title: "Toiletries" },
			{ title: "Medications" },
			{ title: "Chargers & adapters" },
			{ title: "Underwear & socks" },
			{ title: "Water bottle" },
			{ title: "Headphones" },
		],
	},
	{
		kind: "list",
		listKind: "tasks",
		icon: "spray-can",
		tasks: [
			{ title: "Vacuum floors" },
			{ title: "Take out trash & recycling" },
			{ title: "Clean bathroom", priority: 2 },
			{ title: "Change bed sheets" },
			{ title: "Do laundry" },
			{ title: "Wipe kitchen counters" },
			{ title: "Water plants" },
			{ title: "Grocery run", priority: 1 },
		],
	},
	{
		kind: "list",
		listKind: "habits",
		icon: "repeat",
		// Recurrence is added per-habit in the detail surface (templates carry no
		// RRULE); the titles seed a common daily-habits set.
		tasks: [
			{ title: "Drink water" },
			{ title: "Exercise" },
			{ title: "Read" },
			{ title: "Meditate" },
			{ title: "Take vitamins" },
			{ title: "Walk the dog" },
			{ title: "Journal" },
			{ title: "Stretch" },
		],
	},
];
