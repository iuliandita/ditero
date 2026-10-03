import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, test, vi } from "vitest";
import type { HistoricalImportItem } from "../../domain/portability/import-plan-v2.ts";
import {
	freezeHistoricalTargets,
	historicalItemKey,
} from "./import-history-target.ts";

const namespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function item(sourceId = ""): HistoricalImportItem {
	return {
		collection: "comments",
		archiveRowId: "source-comment",
		archiveParentId: "source-task",
		parentKind: "task",
		ledger: {
			collection: "comments",
			targetParentId: "task",
			sourceNamespace: namespace,
			sourceId,
			sourceIdHash: createHash("sha256").update(sourceId).digest("hex"),
		},
		semanticPayload: { body: "History" },
		semanticDigest: "b".repeat(64),
	};
}
function fixture(
	options: {
		moved?: boolean;
		missing?: boolean;
		user?: boolean;
		seat?: boolean;
		ledger?: boolean;
		target?: boolean;
		changed?: boolean;
		tuple?: boolean;
	} = {},
) {
	const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
		let rows: Record<string, unknown>[] = [];
		if (sql.startsWith('select id from "user"'))
			rows = options.user === false ? [] : [{ id: "owner" }];
		else if (sql.startsWith("select t.id"))
			rows = options.missing
				? []
				: [
						{
							id: "task",
							list_id:
								sql.includes("for share") && options.moved
									? "new-list"
									: "list",
							workspace_id: "workspace",
						},
					];
		else if (sql.startsWith("select id from workspace"))
			rows = [{ id: "workspace" }];
		else if (sql.startsWith("select id, workspace_id from membership"))
			rows =
				options.seat === false
					? []
					: [{ id: "seat", workspace_id: "workspace" }];
		else if (sql.startsWith("select id from list")) rows = [{ id: "list" }];
		else if (sql.startsWith("select collection"))
			rows = options.ledger
				? [
						{
							collection: "comments",
							target_parent_id: "task",
							source_namespace: namespace,
							source_row_id_sha256: item().ledger.sourceIdHash,
							source_row_id: options.tuple ? "different" : "",
							target_id: "target",
							content_digest: (options.changed ? "c" : "b").repeat(64),
						},
					]
				: [];
		else if (sql.startsWith('select id, "task_id"'))
			rows =
				options.target === false ? [] : [{ id: "target", parent_id: "task" }];
		return { rows, rowCount: rows.length };
	});
	return { client: { query } as unknown as PoolClient, query };
}

describe("historical target acquisition", () => {
	test("locks authority and rereads task before reading exact ledger identity", async () => {
		const { client, query } = fixture({ ledger: true });
		const result = await freezeHistoricalTargets(client, "owner", [item()]);
		expect(result.get(historicalItemKey(item()))).toMatchObject({
			parent: { membershipId: "seat", listId: "list" },
			decision: { disposition: "replay", targetId: "target" },
		});
		const sql = query.mock.calls.map(([value]) => value);
		expect(
			sql.findIndex((value) => value.startsWith("select id from workspace")),
		).toBeLessThan(
			sql.findIndex((value) =>
				value.startsWith("select id, workspace_id from membership"),
			),
		);
		expect(
			sql.findIndex((value) => value.includes("for share of t")),
		).toBeLessThan(
			sql.findIndex((value) => value.startsWith("select collection")),
		);
		expect(
			query.mock.calls.find(([value]) =>
				value.startsWith("select collection"),
			)?.[1],
		).toEqual([
			JSON.stringify([
				{
					collection: "comments",
					parent: "task",
					namespace,
					hash: item().ledger.sourceIdHash,
				},
			]),
		]);
	});
	test.each([
		{ user: false },
		{ seat: false },
		{ moved: true },
		{ missing: true },
	])("refuses unavailable authority without reading ledger: %j", async (options) => {
		const { client, query } = fixture(options);
		await expect(
			freezeHistoricalTargets(client, "owner", [item()]),
		).rejects.toMatchObject({ code: "historical-parent-unavailable" });
		expect(
			query.mock.calls.some(([sql]) => sql.startsWith("select collection")),
		).toBe(false);
	});
	test.each([
		[{ target: false }, "tombstone"],
		[{ changed: true }, "conflict"],
		[{ tuple: true }, "conflict"],
	] as const)("freezes existing ledger state: %j", async (options, disposition) => {
		const { client } = fixture({ ledger: true, ...options });
		const result = await freezeHistoricalTargets(client, "owner", [item()]);
		expect(result.get(historicalItemKey(item()))?.decision.disposition).toBe(
			disposition,
		);
	});
	test("requires explicit frozen dependency for an absent planned parent", async () => {
		const { client } = fixture({ missing: true });
		const result = await freezeHistoricalTargets(client, "owner", [item()], {
			plannedTasks: new Map([
				["task", { workspaceId: "workspace", dependencySourceKey: "task-key" }],
			]),
		});
		expect(result.get(historicalItemKey(item()))).toMatchObject({
			parent: { listId: null, dependencySourceKey: "task-key" },
			decision: { disposition: "create" },
		});
	});
	test("rejects incorrect source hashes before acquiring authority", async () => {
		const { client, query } = fixture();
		const value = item();
		value.ledger.sourceIdHash = "0".repeat(64);
		await expect(
			freezeHistoricalTargets(client, "owner", [value]),
		).rejects.toMatchObject({ code: "invalid-historical-item" });
		expect(query).not.toHaveBeenCalled();
	});
	test("cancellation and deadline refuse before database work", async () => {
		const { client, query } = fixture();
		await expect(
			freezeHistoricalTargets(client, "owner", [item()], {
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ code: "planning-cancelled" });
		await expect(
			freezeHistoricalTargets(client, "owner", [item()], { deadline: 0 }),
		).rejects.toMatchObject({ code: "planning-timeout" });
		expect(query).not.toHaveBeenCalled();
	});
});
