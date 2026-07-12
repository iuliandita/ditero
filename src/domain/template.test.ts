import { describe, expect, test } from "vitest";
import { keyBetween, keysAreOrdered } from "./sort-key.ts";
import {
	instantiate,
	STARTER_TEMPLATES,
	snapshotList,
	snapshotTask,
	type TemplateContent,
	templateContentSchema,
} from "./template.ts";

const uuid = () => crypto.randomUUID();

// Deterministic counter idGen (mirrors the mutator's seeded generator).
const seeded = (seed: string) => {
	let n = 0;
	return () => {
		const id = n === 0 ? seed : `${seed}-${n}`;
		n++;
		return id;
	};
};

const allKeys = (rows: { sortKey: string }[]) => rows.map((r) => r.sortKey);

describe("snapshotList", () => {
	test("strips timeful fields, keeps content extras + nesting", () => {
		const list = { kind: "shopping" as const, icon: "shopping-cart" };
		const tasks = [
			{
				id: "t1",
				title: "Milk",
				done: true,
				completedAt: 123,
				dueAt: 456,
				sortKey: "a0",
				priority: 2,
				quantity: "2",
				unit: "L",
				category: "Dairy",
				subtasks: [
					{
						id: "s1",
						title: "Whole",
						done: true,
						sortKey: "a0",
						dueAt: 9,
						category: "Dairy",
					},
				],
			},
		];
		const content = snapshotList(list, tasks);
		expect(content).toEqual({
			kind: "list",
			listKind: "shopping",
			icon: "shopping-cart",
			tasks: [
				{
					title: "Milk",
					priority: 2,
					quantity: "2",
					unit: "L",
					category: "Dairy",
					subtasks: [{ title: "Whole", category: "Dairy" }],
				},
			],
		});
		// No timeful keys leaked anywhere in the JSON.
		const json = JSON.stringify(content);
		for (const k of ["id", "done", "completedAt", "dueAt", "sortKey"]) {
			expect(json).not.toContain(`"${k}"`);
		}
	});

	test("omits null icon and drops priority 0 (the 'none' default)", () => {
		const content = snapshotList({ kind: "tasks", icon: null }, [
			{ id: "t", title: "x", done: false, sortKey: "a0", priority: 0 },
		]);
		expect(content).toEqual({
			kind: "list",
			listKind: "tasks",
			tasks: [{ title: "x" }],
		});
	});
});

describe("snapshotTask", () => {
	test("single task + subtasks -> task content", () => {
		const content = snapshotTask(
			{
				id: "t",
				title: "Deploy",
				notes: "prod",
				done: false,
				sortKey: "a0",
				priority: 3,
			},
			[{ id: "s", title: "Run migrations", done: false, sortKey: "a0" }],
		);
		expect(content).toEqual({
			kind: "task",
			task: {
				title: "Deploy",
				notes: "prod",
				priority: 3,
				subtasks: [{ title: "Run migrations" }],
			},
		});
	});
});

describe("instantiate", () => {
	test("list template -> list row + task rows, done=false, ordered keys, no dates", () => {
		const content: TemplateContent = {
			kind: "list",
			listKind: "shopping",
			icon: "shopping-cart",
			tasks: [
				{ title: "Milk", quantity: "2", unit: "L", category: "Dairy" },
				{
					title: "Bread",
					category: "Bakery",
					subtasks: [{ title: "Sourdough" }, { title: "Baguette" }],
				},
			],
		};
		const out = instantiate(content, seeded("L"), keyBetween, {
			sortKey: "m0",
			title: "Weekly shop",
		});
		expect(out.list).toEqual({
			id: "L",
			title: "Weekly shop",
			kind: "shopping",
			sortKey: "m0",
			icon: "shopping-cart",
		});
		expect(out.tasks).toHaveLength(4);
		// Every task points at the fresh list, done=false, no due/completed fields.
		for (const t of out.tasks) {
			expect(t.listId).toBe("L");
			expect(t.done).toBe(false);
			expect(t).not.toHaveProperty("dueAt");
			expect(t).not.toHaveProperty("completedAt");
		}
		const milk = out.tasks.find((t) => t.title === "Milk");
		expect(milk).toMatchObject({ quantity: "2", unit: "L", category: "Dairy" });
		expect(milk?.parentId).toBeUndefined();
		// Subtasks carry parentId of their parent's fresh id.
		const bread = out.tasks.find((t) => t.title === "Bread");
		const subs = out.tasks.filter((t) => t.parentId === bread?.id);
		expect(subs.map((s) => s.title)).toEqual(["Sourdough", "Baguette"]);
		// Top-level keys strictly ordered; sibling subtask keys strictly ordered.
		const top = out.tasks.filter((t) => t.parentId === undefined);
		expect(keysAreOrdered(allKeys(top))).toBe(true);
		expect(keysAreOrdered(allKeys(subs))).toBe(true);
	});

	test("task template -> task rows into the target list", () => {
		const content: TemplateContent = {
			kind: "task",
			task: { title: "Ship", subtasks: [{ title: "a" }, { title: "b" }] },
		};
		const out = instantiate(content, seeded("R"), keyBetween, {
			sortKey: "z0",
			listId: "target",
		});
		expect(out.list).toBeUndefined();
		expect(out.tasks).toHaveLength(3);
		const root = out.tasks.find((t) => t.title === "Ship");
		expect(root).toMatchObject({
			id: "R",
			listId: "target",
			sortKey: "z0",
			done: false,
		});
		const subs = out.tasks.filter((t) => t.parentId === root?.id);
		expect(subs.map((s) => s.title)).toEqual(["a", "b"]);
		expect(keysAreOrdered(allKeys(subs))).toBe(true);
	});

	test("task content without a target listId throws", () => {
		expect(() =>
			instantiate(
				{ kind: "task", task: { title: "x" } },
				seeded("R"),
				keyBetween,
				{
					sortKey: "a0",
				},
			),
		).toThrow(/listId/);
	});

	test("same seed -> convergent ids + structure (client/server rebase)", () => {
		const content: TemplateContent = {
			kind: "list",
			listKind: "shopping",
			icon: "shopping-cart",
			tasks: [
				{ title: "Milk", quantity: "2", unit: "L", category: "Dairy" },
				{
					title: "Bread",
					subtasks: [{ title: "Sourdough" }, { title: "Rye" }],
				},
			],
		};
		const opts = { sortKey: "m0", title: "shop" };
		// The mutator's keyGen (keyBetween) jitters, so sortKeys are NOT stable
		// across runs. Row identity is what must converge, and it comes solely from
		// the seeded id generator — assert everything but the jittered sortKey.
		const stripKeys = (out: ReturnType<typeof instantiate>) => ({
			list: out.list && { ...out.list, sortKey: undefined },
			tasks: out.tasks.map((t) => ({ ...t, sortKey: undefined })),
		});
		const a = instantiate(content, seeded("X"), keyBetween, opts);
		const b = instantiate(content, seeded("X"), keyBetween, opts);
		expect(a.list?.id).toBe(b.list?.id);
		expect(a.tasks.map((t) => t.id)).toEqual(b.tasks.map((t) => t.id));
		expect(stripKeys(a)).toEqual(stripKeys(b));
	});

	test("fresh ids each call", () => {
		const content: TemplateContent = {
			kind: "list",
			listKind: "tasks",
			tasks: [{ title: "a" }, { title: "b" }],
		};
		const first = instantiate(content, uuid, keyBetween, {
			sortKey: "a0",
			title: "t",
		});
		const second = instantiate(content, uuid, keyBetween, {
			sortKey: "a0",
			title: "t",
		});
		const ids = [
			first.list?.id,
			second.list?.id,
			...first.tasks.map((t) => t.id),
			...second.tasks.map((t) => t.id),
		];
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("round-trip snapshot -> instantiate", () => {
	test("preserves titles, extras, and subtask nesting", () => {
		const list = { kind: "shopping" as const, icon: "shopping-cart" };
		const tasks = [
			{
				id: "t1",
				title: "Milk",
				done: true,
				completedAt: 10,
				dueAt: 20,
				sortKey: "a0",
				quantity: "2",
				unit: "L",
				category: "Dairy",
				subtasks: [{ id: "s1", title: "Whole", done: true, sortKey: "a0" }],
			},
		];
		const content = snapshotList(list, tasks);
		const out = instantiate(content, seeded("N"), keyBetween, {
			sortKey: "a0",
			title: "shop",
		});
		const milk = out.tasks.find((t) => t.title === "Milk");
		expect(milk).toMatchObject({
			quantity: "2",
			unit: "L",
			category: "Dairy",
			done: false,
		});
		const sub = out.tasks.find((t) => t.parentId === milk?.id);
		expect(sub?.title).toBe("Whole");
		expect(sub?.done).toBe(false);
	});
});

describe("STARTER_TEMPLATES", () => {
	test("three valid, schema-conformant list templates", () => {
		expect(STARTER_TEMPLATES).toHaveLength(3);
		for (const content of STARTER_TEMPLATES) {
			expect(templateContentSchema.safeParse(content).success).toBe(true);
			expect(content.kind).toBe("list");
		}
	});

	test("each instantiates into a valid list + tasks", () => {
		for (const content of STARTER_TEMPLATES) {
			const out = instantiate(content, uuid, keyBetween, {
				sortKey: "a0",
				title: "x",
			});
			expect(out.list).toBeDefined();
			expect(out.tasks.length).toBeGreaterThanOrEqual(8);
			expect(
				keysAreOrdered(
					allKeys(out.tasks.filter((t) => t.parentId === undefined)),
				),
			).toBe(true);
			for (const t of out.tasks) expect(t.done).toBe(false);
		}
	});
});

describe("templateContentSchema", () => {
	test("rejects a bad discriminant and malformed tasks", () => {
		expect(templateContentSchema.safeParse({ kind: "nope" }).success).toBe(
			false,
		);
		expect(
			templateContentSchema.safeParse({
				kind: "list",
				listKind: "tasks",
				tasks: [{}],
			}).success,
		).toBe(false);
		expect(
			templateContentSchema.safeParse({
				kind: "list",
				listKind: "bogus",
				tasks: [],
			}).success,
		).toBe(false);
	});
});
