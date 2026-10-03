import type { PoolClient } from "pg";
import type { FrozenImportItem } from "../../domain/portability/import-apply-plan.ts";
import type { HistoryPreviewItem } from "../../domain/portability/import-apply-plan-v2.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import {
	HistoricalRowError,
	projectHistoricalRow,
} from "../../domain/portability/import-history-row.ts";
import {
	freezeHistoricalTargets,
	HistoricalTargetError,
	historicalItemKey,
} from "./import-history-target.ts";

export class HistoricalApplyConflict extends Error {
	constructor(
		readonly code: string,
		readonly ordinal: number,
	) {
		super(code);
	}
}
export function isHistoricalItem(
	item: FrozenImportItem | HistoryPreviewItem,
): item is HistoryPreviewItem {
	return (
		item.collection === "completionEvents" ||
		item.phase?.startsWith("history-") === true ||
		(item.dependencyProof !== null && "parent" in item.dependencyProof)
	);
}

// Ordinary parents and source maps are written earlier in the same savepoint.
export async function applyHistoricalItems(
	client: PoolClient,
	ownerId: string,
	jobId: string,
	sourceId: string,
	items: readonly HistoryPreviewItem[],
	checkpoint: () => void,
) {
	const supported = items.filter((item) => item.disposition === "ensure");
	if (!supported.length) return { applied: 0, noop: 0 };
	const time = await client.query<{ at: Date }>(
		"select date_trunc('milliseconds', transaction_timestamp()) as at",
	);
	const ingestedAt = time.rows[0]?.at.toISOString();
	if (!ingestedAt) throw new Error("Import transaction timestamp is missing");
	const projected: {
		item: HistoryPreviewItem;
		value: Awaited<ReturnType<typeof projectHistoricalRow>>;
	}[] = [];
	for (const item of supported) {
		checkpoint();
		try {
			projected.push({
				item,
				value: await projectHistoricalRow(
					item,
					ownerId,
					ingestedAt,
					checkpoint,
				),
			});
		} catch (error) {
			if (!(error instanceof HistoricalRowError)) throw error;
			throw new HistoricalApplyConflict("invalid-plan-evidence", item.ordinal);
		}
	}
	// Serialize absent tuple creation across accounts and import-source copies.
	const tupleKeys = projected
		.map(({ value }) => JSON.stringify(value.historical.ledger))
		.sort();
	for (const key of tupleKeys) {
		checkpoint();
		await client.query(
			"select pg_advisory_xact_lock(hashtextextended($1, 510))",
			[key],
		);
	}
	let snapshots: Awaited<ReturnType<typeof freezeHistoricalTargets>>;
	try {
		snapshots = await freezeHistoricalTargets(
			client,
			ownerId,
			projected.map(({ value }) => value.historical),
		);
	} catch (error) {
		if (!(error instanceof HistoricalTargetError)) throw error;
		throw new HistoricalApplyConflict(error.code, supported[0].ordinal);
	}
	const prepared: {
		item: HistoryPreviewItem;
		value: (typeof projected)[number]["value"];
		noop: boolean;
	}[] = [];
	for (const { item, value } of projected) {
		checkpoint();
		const conflict = (code: string): never => {
			throw new HistoricalApplyConflict(code, item.ordinal);
		};
		const frozen = item.dependencyProof;
		const current = snapshots.get(historicalItemKey(value.historical));
		if (!frozen || !current || !item.targetPrecondition)
			throw new HistoricalApplyConflict("invalid-plan-evidence", item.ordinal);
		if (
			current.parent.kind !== frozen.parent.kind ||
			current.parent.id !== frozen.parent.id ||
			current.parent.workspaceId !== frozen.parent.workspaceId ||
			current.parent.membershipId !== frozen.parent.membershipId ||
			(!frozen.parent.dependencySourceKey &&
				current.parent.listId !== frozen.parent.listId)
		)
			conflict("historical-parent-conflict");
		if (frozen.parent.dependencySourceKey) {
			const parent = await client.query(
				`select i.ordinal from import_item i join import_source_map m
				 on m.source_key = i.source_key and m.source_id = $3 and m.owner_user_id = $4
				 where i.job_id = $1 and i.source_key = $2 and i.ordinal < $5
				 and i.collection = 'tasks' and i.disposition = 'ensure'
				 and i.target_id = $6 and i.payload->>'listId' = $7
				 and i.dependency_proof->'workspace'->>'targetId' = $8
				 and m.collection = 'tasks' and m.target_id = i.target_id
				 and m.target_workspace_id = $8 and m.content_digest = i.content_digest`,
				[
					jobId,
					frozen.parent.dependencySourceKey,
					sourceId,
					ownerId,
					item.ordinal,
					frozen.parent.id,
					current.parent.listId,
					current.parent.workspaceId,
				],
			);
			if (parent.rowCount !== 1) conflict("historical-parent-conflict");
		}
		const decision = current.decision;
		if (decision.disposition === "conflict") conflict(decision.code);
		if (!("targetId" in decision) || decision.targetId !== item.targetId)
			conflict("historical-target-conflict");
		if (
			item.targetPrecondition.kind === "mapped" &&
			current.snapshot.kind === "unmapped"
		)
			conflict("historical-ledger-tuple-conflict");
		prepared.push({
			item,
			value,
			noop: decision.disposition !== "create",
		});
	}
	for (const { item, value, noop } of prepared) {
		checkpoint();
		if (noop) continue;
		const cursor = await client.query(
			`update import_run set next_ordinal = $1 where job_id = $2
			 and owner_user_id = $3 and next_ordinal <= $1
			 and state in ('pending', 'running') returning job_id`,
			[item.ordinal, jobId, ownerId],
		);
		if (cursor.rowCount !== 1)
			throw new HistoricalApplyConflict(
				"import-concurrent-retry",
				item.ordinal,
			);
		await client.query(
			"select set_config('ditero.history_job', $1, true), set_config('ditero.history_ordinal', $2, true)",
			[jobId, String(item.ordinal)],
		);
		const fields = Object.keys(value.row);
		await client.query(
			`insert into "${value.table}" (${fields.map((field) => `"${field}"`).join(",")}) values (${fields.map((_, index) => `$${index + 1}`).join(",")})`,
			Object.values(value.row),
		);
		const tuple = value.historical.ledger;
		const id = await hashImportValue(
			"ditero-import-history-ledger-id-v5",
			[
				tuple.collection,
				tuple.targetParentId,
				tuple.sourceNamespace,
				tuple.sourceId,
			],
			checkpoint,
		);
		await client.query(
			`insert into import_history_ledger
			 (id,collection,target_parent_id,source_namespace,source_row_id_sha256,source_row_id,target_id,content_digest)
			 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
			[
				id,
				tuple.collection,
				tuple.targetParentId,
				tuple.sourceNamespace,
				tuple.sourceIdHash,
				tuple.sourceId,
				item.targetId,
				item.contentDigest,
			],
		);
		await client.query(
			"select set_config('ditero.history_job', '', true), set_config('ditero.history_ordinal', '', true)",
		);
	}
	return {
		applied: prepared.filter((entry) => !entry.noop).length,
		noop: prepared.filter((entry) => entry.noop).length,
	};
}
