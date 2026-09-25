import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { projectImportApply } from "../../domain/portability/import-apply.ts";
import {
	type ImportApplyReport,
	sealImportApplyPlan,
} from "../../domain/portability/import-apply-plan.ts";
import {
	buildImportPlan,
	type ImportMappings,
	ImportPlanError,
} from "../../domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../domain/portability/v1.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import {
	freezeImportTargets,
	ImportFreezeLimitError,
} from "./import-freeze.ts";

export type ImportSourceSelection =
	| { mode: "new"; id: string; label: string }
	| { mode: "existing"; id: string };
export type ImportPlanStatus = {
	id: string;
	sourceId: string;
	sourceLabel: string;
	createdAt: string;
	documentDigest: string;
	mappingDigest: string;
	planDigest: string;
	report:
		| Awaited<ReturnType<typeof buildImportPlan>>["report"]
		| ImportApplyReport;
};
export type ImportSourceStatus = {
	id: string;
	label: string;
	format: string;
	schemaVersion: number;
	sourceUserId: string;
	createdAt: string;
	jobs: ImportPlanStatus[];
};
export class ImportPlanStoreError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super("Import request could not be completed");
		this.name = "ImportPlanStoreError";
	}
}
function fail(code: string, status = 409): never {
	throw new ImportPlanStoreError(code, status);
}
const sourceSchema = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.literal("new"),
			id: z.uuid(),
			label: z.string().trim().min(1).max(100),
		})
		.strict(),
	z.object({ mode: z.literal("existing"), id: z.uuid() }).strict(),
]);

// Pool acquisition cannot be removed from pg's queue after cancellation.
const pendingAcquisitions = new WeakMap<Pool, number>();

export async function importTransaction<T>(
	pool: Pool,
	ownerId: string,
	run: (client: PoolClient) => Promise<T>,
	signal?: AbortSignal,
	deadline = performance.now() + 15_000,
): Promise<T> {
	const acquisitionBudget = Math.ceil(deadline - performance.now());
	if (signal?.aborted) fail("import-cancelled", 408);
	if (acquisitionBudget <= 0) fail("import-timeout", 503);
	if ((pendingAcquisitions.get(pool) ?? 0) >= 2) fail("import-busy", 429);
	pendingAcquisitions.set(pool, (pendingAcquisitions.get(pool) ?? 0) + 1);
	let expired = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelAcquisition: (() => void) | undefined;
	const acquisition = pool.connect().then(
		(client) => {
			pendingAcquisitions.set(pool, (pendingAcquisitions.get(pool) ?? 1) - 1);
			if (expired) client.release();
			return client;
		},
		(error: unknown) => {
			pendingAcquisitions.set(pool, (pendingAcquisitions.get(pool) ?? 1) - 1);
			throw error;
		},
	);
	let client: PoolClient;
	try {
		client = await Promise.race([
			acquisition,
			new Promise<never>((_, reject) => {
				cancelAcquisition = () => {
					expired = true;
					reject(new ImportPlanStoreError("import-cancelled", 408));
				};
				signal?.addEventListener("abort", cancelAcquisition, { once: true });
				if (signal?.aborted) cancelAcquisition();
				timer = setTimeout(() => {
					expired = true;
					reject(new ImportPlanStoreError("import-timeout", 503));
				}, acquisitionBudget);
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (cancelAcquisition)
			signal?.removeEventListener("abort", cancelAcquisition);
	}
	let broken = false;
	let released = false;
	let interruption: ImportPlanStoreError | null = null;
	const interrupt = (error: ImportPlanStoreError) => {
		if (released) return;
		interruption = error;
		released = true;
		// pg destroys an active query's socket, rejecting it before admission is freed.
		client.release(true);
	};
	const cancelTransaction = () =>
		interrupt(new ImportPlanStoreError("import-cancelled", 408));
	const transactionTimer = setTimeout(
		() => interrupt(new ImportPlanStoreError("import-timeout", 503)),
		Math.max(0, deadline - performance.now()),
	);
	signal?.addEventListener("abort", cancelTransaction, { once: true });
	if (signal?.aborted) cancelTransaction();
	try {
		if (interruption) throw interruption;
		await client.query("begin");
		await client.query(
			"select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '15000', true), set_config('ditero.user_id', $1, true)",
			[ownerId],
		);
		const bounded = new Proxy(client, {
			get(target, key) {
				if (key !== "query") return Reflect.get(target, key);
				return async (sql: string, parameters?: unknown[]) => {
					const remaining = Math.ceil(deadline - performance.now());
					if (remaining <= 0) fail("import-timeout", 503);
					if (signal?.aborted) fail("import-cancelled", 408);
					await target.query(
						"select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
						[String(remaining)],
					);
					return target.query(sql, parameters);
				};
			},
		});
		const live = await bounded.query(
			'select id from "user" where id = $1 and deleted_at is null for update',
			[ownerId],
		);
		if (live.rowCount !== 1) fail("inactive-user", 403);
		const result = await run(bounded);
		await bounded.query("commit");
		return result;
	} catch (error) {
		try {
			if (!released) await client.query("rollback");
		} catch {
			broken = true;
		}
		if (interruption) throw interruption;
		if (error instanceof ImportPlanStoreError) throw error;
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			["57014", "55P03", "40P01"].includes(String(error.code))
		)
			fail("import-timeout", 503);
		throw error;
	} finally {
		clearTimeout(transactionTimer);
		signal?.removeEventListener("abort", cancelTransaction);
		if (!released) client.release(broken);
	}
}

const statusProjection = `j.id, j.source_id as "sourceId", s.label as "sourceLabel", j.created_at as "createdAt", j.document_digest as "documentDigest", j.mapping_digest as "mappingDigest", j.plan_digest as "planDigest", j.report`;
type StatusRow = Omit<ImportPlanStatus, "createdAt"> & { createdAt: Date };
const status = (row: StatusRow): ImportPlanStatus => ({
	...row,
	createdAt: row.createdAt.toISOString(),
});
async function findStatus(client: PoolClient, ownerId: string, id: string) {
	const rows = await client.query<StatusRow>(
		`select ${statusProjection} from import_job j join import_source s on s.id = j.source_id where j.id = $1 and j.owner_user_id = $2`,
		[id, ownerId],
	);
	return rows.rows[0] ? status(rows.rows[0]) : null;
}

async function authorizeMappings(
	client: PoolClient,
	ownerId: string,
	document: PortableExportV1,
	mappings: ImportMappings,
) {
	if (mappings.principals[document.sourceUserId] !== ownerId)
		fail("invalid-principal-mapping", 400);
	const workspaceIds = [...new Set(Object.values(mappings.workspaces))].sort();
	const callers = await client.query<{ workspace_id: string; role: Role }>(
		`select m.workspace_id, m.role from membership m join workspace w on w.id = m.workspace_id where m.user_id = $1 and m.workspace_id = any($2::text[]) order by m.id for share of m, w`,
		[ownerId, workspaceIds],
	);
	if (
		callers.rows.length !== workspaceIds.length ||
		callers.rows.some((row) => !WRITE_ROLES.has(row.role))
	)
		fail("invalid-workspace-mapping", 403);
	const principals = [
		...new Set(
			Object.values(mappings.principals).filter(
				(value): value is string => value !== null,
			),
		),
	].sort();
	const live = await client.query(
		'select id from "user" where id = any($1::text[]) and deleted_at is null order by id for key share',
		[principals],
	);
	if (live.rowCount !== principals.length)
		fail("invalid-principal-mapping", 403);
	const seats = await client.query<{ user_id: string; workspace_id: string }>(
		`select user_id, workspace_id from membership where user_id = any($1::text[]) and workspace_id = any($2::text[]) order by id for share`,
		[principals, workspaceIds],
	);
	const existing = new Set(
		seats.rows.map((row) => JSON.stringify([row.user_id, row.workspace_id])),
	);
	const lists = new Map(
		document.data.lists.map((row) => [row.id, row.workspaceId]),
	);
	const tasks = new Map(
		document.data.tasks.map((row) => [row.id, lists.get(row.listId)]),
	);
	const required = (
		principal: string | null,
		workspace: string | null | undefined,
	) => {
		if (!principal || !workspace) return;
		const targetPrincipal = mappings.principals[principal];
		const targetWorkspace = mappings.workspaces[workspace];
		if (
			targetPrincipal &&
			targetWorkspace &&
			!existing.has(JSON.stringify([targetPrincipal, targetWorkspace]))
		)
			fail("invalid-principal-mapping", 403);
	};
	for (const row of document.data.memberships)
		required(row.userId, row.workspaceId);
	for (const row of document.data.workspaces) required(row.ownerId, row.id);
	for (const row of document.data.lists) required(row.ownerId, row.workspaceId);
	for (const row of document.data.templates)
		required(row.createdBy, row.workspaceId);
	for (const row of document.data.assignments)
		required(row.userId, tasks.get(row.taskId));
	for (const row of document.data.tasks)
		required(row.fallbackUserId, lists.get(row.listId));
	for (const row of document.data.comments)
		required(row.authorId, tasks.get(row.taskId));
	for (const row of document.data.attachments)
		required(row.uploadedBy, row.workspaceId);
	for (const row of [...document.data.views, ...document.data.dashboards])
		required(row.ownerId, row.workspaceId);
}

export async function saveImportPlan(
	pool: Pool,
	ownerId: string,
	sourceSelection: ImportSourceSelection,
	document: PortableExportV1,
	mappings: ImportMappings,
	options: {
		signal?: AbortSignal;
		deadline?: number;
		plannerVersion?: 1 | 2 | 3;
	} = {},
): Promise<ImportPlanStatus> {
	const deadline = Math.min(
		options.deadline ?? Number.POSITIVE_INFINITY,
		performance.now() + 15_000,
	);
	const parsed = sourceSchema.safeParse(sourceSelection);
	if (!parsed.success) fail("invalid-source", 400);
	const selection = parsed.data;
	const basePlan = await buildImportPlan(document, {
		ownerUserId: ownerId,
		sourceId: selection.id,
		mappings,
		signal: options.signal,
		deadline,
	}).catch((error: unknown) => {
		if (error instanceof ImportPlanError && error.code === "planning-timeout")
			fail("import-timeout", 503);
		if (error instanceof ImportPlanError && error.code === "planning-cancelled")
			fail("import-cancelled", 408);
		throw error;
	});
	return importTransaction(
		pool,
		ownerId,
		async (client) => {
			if (options.plannerVersion === 3) {
				// Account deletion locks users before workspace memberships.
				const assignees = [
					...new Set(
						document.data.assignments
							.map((row) => mappings.principals[row.userId])
							.filter((id): id is string => typeof id === "string"),
					),
				].sort();
				const live = await client.query(
					'select id from "user" where id = any($1::text[]) and deleted_at is null order by id for share',
					[assignees],
				);
				if (live.rowCount !== assignees.length)
					fail("invalid-principal-mapping", 403);
			}
			await authorizeMappings(client, ownerId, document, mappings);
			const sources = await client.query<{
				label: string;
				format: string;
				schema_version: number;
				source_user_id: string;
			}>(
				"select label, format, schema_version, source_user_id from import_source where id = $1 and owner_user_id = $2",
				[selection.id, ownerId],
			);
			const source = sources.rows[0];
			if (!source && selection.mode === "existing")
				fail("source-not-found", 404);
			if (
				source &&
				(source.format !== document.format ||
					source.schema_version !== document.schemaVersion ||
					source.source_user_id !== document.sourceUserId ||
					(selection.mode === "new" && source.label !== selection.label))
			)
				fail("source-binding-conflict");
			let plan:
				| typeof basePlan
				| Awaited<ReturnType<typeof sealImportApplyPlan>> = basePlan;
			if (options.plannerVersion === 2 || options.plannerVersion === 3) {
				const candidates = projectImportApply(document, basePlan.items, {
					plannerVersion: options.plannerVersion,
					signal: options.signal,
					deadline,
				});
				const frozen = await freezeImportTargets(
					client,
					ownerId,
					selection.id,
					document,
					mappings,
					candidates.items,
					{ signal: options.signal, deadline },
				);
				plan = await sealImportApplyPlan(frozen.items, frozen.snapshots, {
					plannerVersion: options.plannerVersion,
					ownerUserId: ownerId,
					sourceId: selection.id,
					documentDigest: basePlan.documentDigest,
					mappingDigest: basePlan.mappingDigest,
					signal: options.signal,
					deadline,
				});
			}
			const duplicate = await findStatus(client, ownerId, plan.planDigest);
			if (duplicate) return duplicate;
			const serialized = JSON.stringify(plan.items);
			const payloadBytes =
				Buffer.byteLength(serialized) +
				Buffer.byteLength(JSON.stringify(plan.report));
			const quota = await client.query<{
				sources: number;
				jobs: number;
				bytes: string;
			}>(
				`select (select count(*)::int from import_source where owner_user_id = $1) as sources, count(*)::int as jobs, coalesce(sum(payload_bytes), 0)::text as bytes from import_job where owner_user_id = $1`,
				[ownerId],
			);
			const usage = quota.rows[0];
			if (
				!usage ||
				(!source && usage.sources >= 10) ||
				usage.jobs >= 10 ||
				Number(usage.bytes) + payloadBytes > 64 * 1024 * 1024
			)
				fail("import-quota-exceeded", 413);
			if (!source && selection.mode === "new") {
				const created = await client.query(
					`insert into import_source (id, owner_user_id, label, format, schema_version, source_user_id) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id`,
					[
						selection.id,
						ownerId,
						selection.label,
						document.format,
						document.schemaVersion,
						document.sourceUserId,
					],
				);
				if (created.rowCount !== 1) fail("source-binding-conflict");
			}
			await client.query(
				`insert into import_job (id, source_id, owner_user_id, document_digest, mapping_digest, plan_digest, report, payload_bytes, planner_version, apply_supported) values ($1,$2,$3,$4,$5,$1,$6::jsonb,$7,$8,$9)`,
				[
					plan.planDigest,
					selection.id,
					ownerId,
					plan.documentDigest,
					plan.mappingDigest,
					JSON.stringify(plan.report),
					payloadBytes,
					plan.report.plannerVersion,
					plan.report.applySupported,
				],
			);
			await client.query(
				`insert into import_item (job_id, ordinal, collection, source_id, source_key, item_digest, target_id, disposition, payload, codes, phase, content_digest, target_precondition, dependency_proof) select $1, ordinal, collection, "sourceId", "sourceKey", "itemDigest", "targetId", disposition, payload, codes, phase, "contentDigest", "targetPrecondition", "dependencyProof" from jsonb_to_recordset($2::jsonb) as i(ordinal integer, collection text, "sourceId" text, "sourceKey" text, "itemDigest" text, "targetId" text, disposition text, payload jsonb, codes jsonb, phase text, "contentDigest" text, "targetPrecondition" jsonb, "dependencyProof" jsonb)`,
				[plan.planDigest, serialized],
			);
			const saved = await findStatus(client, ownerId, plan.planDigest);
			if (!saved) throw new Error("Saved import job is missing");
			return saved;
		},
		options.signal,
		deadline,
	).catch((error: unknown) => {
		if (error instanceof ImportFreezeLimitError) fail(error.code, error.status);
		if (error instanceof ImportPlanError && error.code === "planning-timeout")
			fail("import-timeout", 503);
		if (error instanceof ImportPlanError && error.code === "planning-cancelled")
			fail("import-cancelled", 408);
		throw error;
	});
}

export async function listImportSources(
	pool: Pool,
	ownerId: string,
): Promise<ImportSourceStatus[]> {
	return importTransaction(pool, ownerId, async (client) => {
		const sources = await client.query<
			Omit<ImportSourceStatus, "createdAt" | "jobs"> & { createdAt: Date }
		>(
			`select id, label, format, schema_version as "schemaVersion", source_user_id as "sourceUserId", created_at as "createdAt" from import_source where owner_user_id = $1 order by created_at, id`,
			[ownerId],
		);
		const jobs = await client.query<StatusRow>(
			`select ${statusProjection} from import_job j join import_source s on s.id = j.source_id where j.owner_user_id = $1 order by j.created_at, j.id`,
			[ownerId],
		);
		return sources.rows.map((source) => ({
			...source,
			createdAt: source.createdAt.toISOString(),
			jobs: jobs.rows.filter((job) => job.sourceId === source.id).map(status),
		}));
	});
}
export async function getImportPlanStatus(
	pool: Pool,
	ownerId: string,
	jobId: string,
): Promise<ImportPlanStatus | null> {
	return importTransaction(pool, ownerId, (client) =>
		findStatus(client, ownerId, jobId),
	);
}
export async function discardImportSource(
	pool: Pool,
	ownerId: string,
	sourceId: string,
): Promise<boolean> {
	return importTransaction(pool, ownerId, async (client) => {
		const source = await client.query(
			"select id from import_source where id = $1 and owner_user_id = $2",
			[sourceId, ownerId],
		);
		if (source.rowCount !== 1) return false;
		const retained = await client.query<{ mapped: boolean; active: boolean }>(
			`select exists(select 1 from import_source_map where source_id = $1) or exists(select 1 from import_workspace_map where source_id = $1) as mapped,
				exists(select 1 from import_run r join import_job j on j.id = r.job_id where j.source_id = $1 and r.state in ('pending', 'running')) as active`,
			[sourceId],
		);
		if (retained.rows[0]?.mapped) fail("import-source-retained");
		if (retained.rows[0]?.active) fail("import-run-incomplete");
		return (
			(
				await client.query(
					"delete from import_source where id = $1 and owner_user_id = $2 returning id",
					[sourceId, ownerId],
				)
			).rowCount === 1
		);
	});
}
export async function discardImportPlan(
	pool: Pool,
	ownerId: string,
	jobId: string,
): Promise<boolean> {
	return importTransaction(pool, ownerId, async (client) => {
		const job = await client.query<{ source_id: string }>(
			"select source_id from import_job where id = $1 and owner_user_id = $2",
			[jobId, ownerId],
		);
		if (!job.rows[0]) return false;
		await client.query(
			"select id from import_source where id = $1 and owner_user_id = $2",
			[job.rows[0].source_id, ownerId],
		);
		const run = await client.query<{ state: string }>(
			"select state from import_run where job_id = $1 and owner_user_id = $2 for update",
			[jobId, ownerId],
		);
		if (run.rows[0] && ["pending", "running"].includes(run.rows[0].state))
			fail("import-run-incomplete");
		return (
			(
				await client.query(
					"delete from import_job where id = $1 and owner_user_id = $2 returning id",
					[jobId, ownerId],
				)
			).rowCount === 1
		);
	});
}
