import type { PoolClient } from "pg";
import { expect, test } from "vitest";
import {
	type ImportApplyCandidate,
	projectImportApply,
} from "../../domain/portability/import-apply.ts";
import {
	digestImportContent,
	sealImportApplyPlan,
} from "../../domain/portability/import-apply-plan.ts";
import { buildImportPlan } from "../../domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../domain/portability/v1.ts";
import { freezeImportTargets } from "./import-freeze.ts";
import { digestImportTarget } from "./import-target.ts";

const date = "2026-01-01T00:00:00.000Z";
type LabelRow = {
	id: string;
	workspace_id: string;
	name: string;
	color: string;
};
type MapRow = {
	source_key: string;
	collection: string;
	source_row_id: string;
	target_id: string;
	target_workspace_id: string;
	content_digest: string;
	last_target_digest: string;
	version: number;
};

function document(labelName: string): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: date,
		sourceUserId: "self",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			principals: [{ id: "self", name: "Self" }],
			workspaces: [
				{ id: "workspace", name: "Workspace", ownerId: "self", kind: "shared" },
			],
			memberships: [],
			folders: [],
			lists: [
				{
					id: "list",
					workspaceId: "workspace",
					ownerId: "self",
					title: "List",
					kind: "tasks",
					icon: null,
					folderId: null,
					sortKey: "a",
					completedDisplay: "sink",
				},
			],
			tasks: [
				{
					id: "task",
					listId: "list",
					parentId: null,
					title: "Task",
					done: false,
					notes: null,
					dueAt: null,
					dueAllDay: false,
					priority: 0,
					completedAt: null,
					sortKey: "a",
					quantity: null,
					unit: null,
					category: null,
					rrule: null,
					recurrenceRelative: false,
					reminderTime: null,
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				},
			],
			labels: [
				{
					id: "label",
					workspaceId: "workspace",
					name: labelName,
					color: "red",
				},
			],
			taskLabels: [{ id: "task-label", taskId: "task", labelId: "label" }],
			templates: [],
			assignments: [],
			comments: [],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
		},
	};
}

// Answers the freeze queries from in-memory label rows, filtering the way the
// real SQL does: by id, or by (workspace, name) natural key.
function client(labels: LabelRow[], maps: MapRow[] = []) {
	return {
		async query(sql: string, params: unknown[] = []) {
			if (sql.includes("import_workspace_map")) return { rows: [] };
			if (sql.includes("from import_source_map")) return { rows: maps };
			if (sql.startsWith('select r.id from "label" r')) {
				const ids = params[0] as string[];
				const natural = JSON.parse(String(params[1])) as {
					workspace: string;
					name: string;
				}[];
				return {
					rows: labels.filter(
						(row) =>
							ids.includes(row.id) ||
							natural.some(
								(key) =>
									key.workspace === row.workspace_id && key.name === row.name,
							),
					),
				};
			}
			if (sql.startsWith("select coalesce(sum("))
				return { rows: [{ bytes: "1" }] };
			if (sql.includes('from "label" where id = any'))
				return {
					rows: labels.filter((row) =>
						(params[0] as string[]).includes(row.id),
					),
				};
			if (/^select r\.id from "/.test(sql)) return { rows: [] };
			throw new Error(`unexpected query: ${sql}`);
		},
	} as unknown as PoolClient;
}

async function candidates(source: PortableExportV1) {
	const mappings = {
		workspaces: { workspace: "target" },
		principals: { self: "owner" },
	};
	const plan = await buildImportPlan(source, {
		ownerUserId: "owner",
		sourceId: "source",
		mappings,
	});
	return { mappings, items: projectImportApply(source, plan.items).items };
}
async function freeze(
	source: PortableExportV1,
	pool: PoolClient,
	reuseProviderLabels = true,
) {
	const { mappings, items } = await candidates(source);
	return freezeImportTargets(pool, "owner", "source", source, mappings, items, {
		plannerVersion: 2,
		reuseProviderLabels,
	});
}
const noCheckpoint = () => {};
const find = (items: ImportApplyCandidate[], collection: string) => {
	const item = items.find((entry) => entry.collection === collection);
	if (!item) throw new Error(`no ${collection} item`);
	return item;
};

test("an imported label with the same name in the target workspace reuses that label and its color", async () => {
	const source = document("Work");
	const { items, snapshots } = await freeze(
		source,
		client([
			{ id: "existing", workspace_id: "target", name: "Work", color: "teal" },
		]),
	);
	const label = find(items, "labels");
	expect(label).toMatchObject({
		disposition: "ensure",
		targetId: "existing",
		payload: { id: "existing", name: "Work", color: "teal" },
	});
	expect(snapshots.get(label.sourceKey)?.targetPrecondition.kind).toBe(
		"existing-label",
	);
	const link = find(items, "taskLabels");
	expect(link.disposition).toBe("ensure");
	expect(link.payload).toMatchObject({ labelId: "existing" });
	expect(
		snapshots
			.get(link.sourceKey)
			?.dependencyProof.rows.some(
				(row) => row.collection === "labels" && row.id === "existing",
			),
	).toBe(true);
	const sealed = await sealImportApplyPlan(items, snapshots, {
		plannerVersion: 2,
		ownerUserId: "owner",
		sourceId: "source",
		documentDigest: "d",
		mappingDigest: "m",
	});
	expect(sealed.report.counts.blocked).toBe(0);
});

test("names match exactly, as the label uniqueness constraint does", async () => {
	const { items, snapshots } = await freeze(
		document("work"),
		client([
			{ id: "existing", workspace_id: "target", name: "Work", color: "teal" },
		]),
	);
	const label = find(items, "labels");
	expect(label.targetId).not.toBe("existing");
	expect(snapshots.get(label.sourceKey)?.targetPrecondition.kind).toBe(
		"absent",
	);
});

test("a same-named label in another workspace is never reused", async () => {
	const { items, snapshots } = await freeze(
		document("Work"),
		client([
			{ id: "foreign", workspace_id: "elsewhere", name: "Work", color: "teal" },
		]),
	);
	const label = find(items, "labels");
	expect(label.targetId).not.toBe("foreign");
	expect(snapshots.get(label.sourceKey)?.targetPrecondition.kind).toBe(
		"absent",
	);
});

test("a source mapping that points at a label in another workspace blocks instead of reusing it", async () => {
	const source = document("Work");
	const label = find((await candidates(source)).items, "labels");
	const { items } = await freeze(
		source,
		client(
			[
				{
					id: "foreign",
					workspace_id: "elsewhere",
					name: "Work",
					color: "teal",
				},
			],
			[
				{
					source_key: label.sourceKey,
					collection: "labels",
					source_row_id: label.sourceId,
					target_id: "foreign",
					target_workspace_id: "target",
					content_digest: "x",
					last_target_digest: "x",
					version: 1,
				},
			],
		),
	);
	expect(find(items, "labels")).toMatchObject({
		disposition: "blocked",
		codes: ["source-mapping-conflict"],
	});
});

test("without the provider flag an existing label still blocks, so native imports are unchanged", async () => {
	const { items } = await freeze(
		document("Work"),
		client([
			{ id: "existing", workspace_id: "target", name: "Work", color: "teal" },
		]),
		false,
	);
	expect(find(items, "labels")).toMatchObject({
		disposition: "blocked",
		codes: ["target-natural-key-collision"],
	});
});

test("re-planning after a reuse maps the same label instead of reusing it again", async () => {
	const source = document("Work");
	const existing = {
		id: "existing",
		workspace_id: "target",
		name: "Work",
		color: "teal",
	};
	const first = find(
		(await freeze(source, client([existing]))).items,
		"labels",
	);
	const map: MapRow = {
		source_key: first.sourceKey,
		collection: "labels",
		source_row_id: first.sourceId,
		target_id: "existing",
		target_workspace_id: "target",
		content_digest: await digestImportContent(first, noCheckpoint),
		last_target_digest: await digestImportTarget(
			"labels",
			existing,
			noCheckpoint,
		),
		version: 1,
	};
	const { items, snapshots } = await freeze(source, client([existing], [map]));
	const label = find(items, "labels");
	expect(label).toMatchObject({ disposition: "ensure", targetId: "existing" });
	expect(snapshots.get(label.sourceKey)?.targetPrecondition.kind).toBe(
		"mapped",
	);
});
