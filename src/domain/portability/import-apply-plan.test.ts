import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	type ImportApplyCandidate,
	projectImportApply,
} from "./import-apply.ts";
import {
	type ImportTargetSnapshot,
	sealImportApplyPlan,
} from "./import-apply-plan.ts";
import { buildImportPlan } from "./import-plan.ts";
import type { PortableExportV1 } from "./v1.ts";
import { parsePortableExportV1 } from "./validate.ts";

const context = {
	ownerUserId: "owner",
	sourceId: "source",
	documentDigest: "document-digest",
	mappingDigest: "mapping-digest",
};

function candidate(): ImportApplyCandidate {
	return {
		ordinal: 0,
		collection: "tasks",
		sourceId: "source-task",
		sourceKey: "task-source-key",
		targetId: "target-task",
		disposition: "ensure",
		payload: { id: "target-task", listId: "target-list", title: "Task" },
		codes: [],
		phase: "root-tasks",
		dependencies: [
			{ collection: "lists", sourceId: "source-list", sourceKey: "list-key" },
		],
	};
}

function snapshot(): ImportTargetSnapshot {
	return {
		targetPrecondition: { kind: "absent", naturalKey: null },
		dependencyProof: {
			workspace: { sourceId: "source-workspace", targetId: "target-workspace" },
			rows: [
				{
					collection: "lists",
					sourceKey: "list-key",
					itemOrdinal: 0,
					id: "target-list",
					workspaceId: "target-workspace",
				},
				{
					collection: "tasks",
					sourceKey: "parent-key",
					itemOrdinal: 1,
					id: "target-parent",
					workspaceId: "target-workspace",
					listId: "target-list",
					parentId: null,
				},
			],
		},
	};
}

function seal(item = candidate(), target = snapshot()) {
	return sealImportApplyPlan(
		[item],
		new Map([[item.sourceKey, target]]),
		context,
	);
}

describe("sealed import apply plan", () => {
	test.each([
		undefined,
		2,
	] as const)("preserves the captured v2 fixture with version %s", async (plannerVersion) => {
		const golden = JSON.parse(
			readFileSync(
				new URL(
					"../../../tests/fixtures/portability/import-v2-golden.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			input: {
				document: PortableExportV1;
				context: Parameters<typeof buildImportPlan>[1];
			};
			basePlanV1: Awaited<ReturnType<typeof buildImportPlan>>;
			projectedV2: ReturnType<typeof projectImportApply>;
			sealInput: {
				context: Parameters<typeof sealImportApplyPlan>[2];
				snapshots: (ImportTargetSnapshot & { sourceKey: string })[];
			};
			expectedSealedV2: Awaited<ReturnType<typeof sealImportApplyPlan>>;
		};
		const document = parsePortableExportV1(
			JSON.stringify(golden.input.document),
		);
		const base = await buildImportPlan(document, golden.input.context);
		expect(base).toEqual(golden.basePlanV1);
		const projected = projectImportApply(document, base.items, {
			plannerVersion,
		});
		expect(projected).toEqual(golden.projectedV2);
		const snapshots = new Map(
			golden.sealInput.snapshots.map(({ sourceKey, ...snapshot }) => [
				sourceKey,
				snapshot,
			]),
		);
		const sealed = await sealImportApplyPlan(projected.items, snapshots, {
			...golden.sealInput.context,
			plannerVersion,
		});
		expect(JSON.stringify(sealed)).toBe(
			JSON.stringify(golden.expectedSealedV2),
		);
		expect(sealed.planDigest).toBe(
			"dd0a219d6f71748ebd2201966a0632ec73a3a7e0b4c245d8f563b56009f6e026",
		);
	});
	test("v3 changes execution identity while preserving existing source-map content identity", async () => {
		const item = candidate();
		const snapshots = new Map([[item.sourceKey, snapshot()]]);
		const v2 = await sealImportApplyPlan([item], snapshots, context);
		const v3 = await sealImportApplyPlan([item], snapshots, {
			...context,
			plannerVersion: 3,
		});
		expect(v3.report.plannerVersion).toBe(3);
		expect(v3.items[0].contentDigest).toBe(v2.items[0].contentDigest);
		expect(v3.items[0].itemDigest).not.toBe(v2.items[0].itemDigest);
		expect(v3.planDigest).not.toBe(v2.planDigest);
		expect(v3.items[0].dependencyProof).toEqual(v2.items[0].dependencyProof);
		expect(v3.items[0].dependencyProof).not.toHaveProperty("assignee");
	});
	function assignment() {
		const item: ImportApplyCandidate = {
			...candidate(),
			collection: "assignments",
			phase: "assignments",
			targetId: "target-task:target-user",
			payload: {
				id: "target-task:target-user",
				taskId: "target-task",
				userId: "target-user",
			},
		};
		const target: ImportTargetSnapshot = {
			...snapshot(),
			targetPrecondition: {
				kind: "absent",
				naturalKey: {
					kind: "task-assignee-pair",
					taskId: "target-task",
					userId: "target-user",
				},
			},
			dependencyProof: {
				...snapshot().dependencyProof,
				assignee: {
					sourceUserId: "source-user",
					targetUserId: "target-user",
					workspaceId: "target-workspace",
					membershipId: "membership",
				},
			},
		};
		return { item, target };
	}
	test("v3 freezes membership evidence without changing stable assignment content", async () => {
		const { item, target } = assignment();
		const before = structuredClone({ item, target });
		const original = await sealImportApplyPlan(
			[item],
			new Map([[item.sourceKey, target]]),
			{ ...context, plannerVersion: 3 },
		);
		const replacement = structuredClone(target);
		if (!replacement.dependencyProof.assignee)
			throw new Error("Missing assignee fixture");
		replacement.dependencyProof.assignee.membershipId =
			"replacement-membership";
		const changed = await sealImportApplyPlan(
			[item],
			new Map([[item.sourceKey, replacement]]),
			{ ...context, plannerVersion: 3 },
		);
		expect(changed.items[0].contentDigest).toBe(
			original.items[0].contentDigest,
		);
		expect(changed.items[0].itemDigest).not.toBe(original.items[0].itemDigest);
		expect(changed.planDigest).not.toBe(original.planDigest);
		expect(original.items[0].dependencyProof?.assignee?.membershipId).toBe(
			"membership",
		);
		expect({ item, target }).toEqual(before);
	});
	test.each([
		"missing",
		"user",
		"workspace",
		"membership",
		"canonical-id",
		"natural-key",
	])("rejects v3 assignment with invalid %s evidence", async (field) => {
		const { item, target } = assignment();
		if (field === "missing") delete target.dependencyProof.assignee;
		if (field === "user" && target.dependencyProof.assignee)
			target.dependencyProof.assignee.targetUserId = "different-user";
		if (field === "workspace" && target.dependencyProof.assignee)
			target.dependencyProof.assignee.workspaceId = "different-workspace";
		if (field === "membership" && target.dependencyProof.assignee)
			target.dependencyProof.assignee.membershipId = "";
		if (field === "canonical-id") item.targetId = "generic-import-hash";
		if (field === "natural-key")
			target.targetPrecondition = { kind: "absent", naturalKey: null };
		await expect(
			sealImportApplyPlan([item], new Map([[item.sourceKey, target]]), {
				...context,
				plannerVersion: 3,
			}),
		).rejects.toMatchObject({ code: "invalid-mappings" });
	});
	test("rejects assignee evidence on unrelated v3 content and unknown plan versions", async () => {
		const { target } = assignment();
		const item = candidate();
		await expect(
			sealImportApplyPlan([item], new Map([[item.sourceKey, target]]), {
				...context,
				plannerVersion: 3,
			}),
		).rejects.toMatchObject({ code: "invalid-mappings" });
		await expect(
			sealImportApplyPlan([item], new Map([[item.sourceKey, snapshot()]]), {
				...context,
				plannerVersion: 4 as 3,
			}),
		).rejects.toMatchObject({ code: "invalid-mappings" });
	});
	test("database dependency order does not change sealed identity", async () => {
		const original = await seal();
		const reordered = snapshot();
		reordered.dependencyProof.rows.reverse();
		const before = structuredClone(reordered);
		const result = await seal(candidate(), reordered);
		expect(result).toEqual(original);
		expect(reordered).toEqual(before);
	});

	test("seals absent and mapped snapshots differently while preserving content identity", async () => {
		const absent = await seal();
		const mappedSnapshot = snapshot();
		mappedSnapshot.targetPrecondition = {
			kind: "mapped",
			mapVersion: 1,
			targetDigest: "existing-target-digest",
		};
		const mapped = await seal(candidate(), mappedSnapshot);
		expect(mapped.items[0].contentDigest).toBe(absent.items[0].contentDigest);
		expect(mapped.items[0].itemDigest).not.toBe(absent.items[0].itemDigest);
		expect(mapped.planDigest).not.toBe(absent.planDigest);
		const newVersion = structuredClone(mappedSnapshot);
		newVersion.targetPrecondition = {
			kind: "mapped",
			mapVersion: 2,
			targetDigest: "existing-target-digest",
		};
		const changed = await seal(candidate(), newVersion);
		expect(changed.items[0].contentDigest).toBe(mapped.items[0].contentDigest);
		expect(changed.planDigest).not.toBe(mapped.planDigest);
	});

	test.each([
		"workspace",
		"row-workspace",
		"list",
		"parent",
	])("includes dependency %s evidence in plan identity", async (field) => {
		const original = await seal();
		const changed = snapshot();
		if (field === "workspace")
			changed.dependencyProof.workspace.targetId = "other-workspace";
		if (field === "row-workspace")
			changed.dependencyProof.rows[0].workspaceId = "other-workspace";
		if (field === "list") changed.dependencyProof.rows[1].listId = "other-list";
		if (field === "parent")
			changed.dependencyProof.rows[1].parentId = "other-parent";
		const result = await seal(candidate(), changed);
		expect(result.items[0].contentDigest).toBe(original.items[0].contentDigest);
		expect(result.items[0].itemDigest).not.toBe(original.items[0].itemDigest);
		expect(result.planDigest).not.toBe(original.planDigest);
	});

	test("source payload changes content identity", async () => {
		const original = await seal();
		const changed = candidate();
		changed.payload = {
			id: "target-task",
			listId: "target-list",
			title: "Changed",
		};
		const result = await seal(changed);
		expect(result.items[0].contentDigest).not.toBe(
			original.items[0].contentDigest,
		);
		expect(result.items[0].itemDigest).not.toBe(original.items[0].itemDigest);
		expect(result.planDigest).not.toBe(original.planDigest);
	});

	test("rejects missing and extra target snapshots", async () => {
		const item = candidate();
		await expect(
			sealImportApplyPlan([item], new Map(), context),
		).rejects.toMatchObject({ code: "invalid-mappings" });
		await expect(
			sealImportApplyPlan(
				[item],
				new Map([
					[item.sourceKey, snapshot()],
					["unrelated-key", snapshot()],
				]),
				context,
			),
		).rejects.toMatchObject({ code: "invalid-mappings" });
	});

	test("exclusions require no snapshot and report exact counts and findings", async () => {
		const ensured = candidate();
		const blocked: ImportApplyCandidate = {
			...candidate(),
			ordinal: 1,
			sourceId: "blocked",
			sourceKey: "blocked-key",
			disposition: "blocked",
			phase: null,
			targetId: null,
			codes: ["notification-bearing-task"],
		};
		const ignored: ImportApplyCandidate = {
			...candidate(),
			ordinal: 2,
			sourceId: "ignored",
			sourceKey: "ignored-key",
			disposition: "ignored",
			phase: null,
			targetId: null,
			codes: ["authority-not-imported"],
		};
		const items = [ensured, blocked, ignored];
		const snapshots = new Map([[ensured.sourceKey, snapshot()]]);
		const result = await sealImportApplyPlan(items, snapshots, context);
		expect(result.report).toEqual({
			plannerVersion: 2,
			applySupported: true,
			counts: { ensure: 1, ignored: 1, blocked: 1 },
			findings: [
				{ code: "notification-bearing-task", path: "items[1]" },
				{ code: "authority-not-imported", path: "items[2]" },
			],
		});
		for (const item of result.items.slice(1)) {
			expect(item.targetPrecondition).toBeNull();
			expect(item.dependencyProof).toBeNull();
		}
		for (const excluded of [blocked, ignored]) {
			await expect(
				sealImportApplyPlan(
					items,
					new Map([...snapshots, [excluded.sourceKey, snapshot()]]),
					context,
				),
			).rejects.toMatchObject({ code: "invalid-mappings" });
		}
	});

	test.each([
		"sourceId",
		"ownerUserId",
	])("binds the plan to %s", async (field) => {
		const item = candidate();
		const original = await seal(item);
		const changed = await sealImportApplyPlan(
			[item],
			new Map([[item.sourceKey, snapshot()]]),
			{ ...context, [field]: "different" },
		);
		expect(changed.planDigest).not.toBe(original.planDigest);
	});

	test("honors deadlines and cancellation including in-flight hashing", async () => {
		const item = candidate();
		const snapshots = new Map([[item.sourceKey, snapshot()]]);
		await expect(
			sealImportApplyPlan([item], snapshots, {
				...context,
				deadline: performance.now() - 1,
			}),
		).rejects.toMatchObject({ code: "planning-timeout" });
		await expect(
			sealImportApplyPlan([item], snapshots, {
				...context,
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ code: "planning-cancelled" });
		const controller = new AbortController();
		const pending = sealImportApplyPlan([item], snapshots, {
			...context,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "planning-cancelled" });
	});

	test("does not mutate or retain references to source candidates and snapshots", async () => {
		const item = candidate();
		const target = snapshot();
		const before = structuredClone({ item, target });
		const result = await seal(item, target);
		expect({ item, target }).toEqual(before);
		result.items[0].codes.push("changed");
		result.items[0].dependencyProof?.rows.pop();
		expect({ item, target }).toEqual(before);
	});
});
