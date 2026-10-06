import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { storageKeyFor } from "../../domain/attachment.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import {
	attachmentQuotaWouldExceed,
	validateAttachmentWrite,
} from "../attachments/quota.ts";
import { e2eBlobSchema } from "../e2e/input.ts";
import { readAttachmentMigrationParentOnClient } from "./attachment-migration-parents.ts";
import {
	ImportPlanStoreError,
	importTransaction,
} from "./import-plan-store.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z
	.string()
	.min(1)
	.max(128)
	.refine((s) => !s.includes("\0") && s.isWellFormed());
const envelopeText = e2eBlobSchema.refine(
	(value) => !value.includes("\0") && value.isWellFormed(),
);
const preparedSchema = z
	.strictObject({
		id: z
			.string()
			.regex(
				/^migration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
		keyVersion: z.number().int().min(1).max(2147483647),
		filenameCiphertext: envelopeText,
		contentTypeCiphertext: envelopeText,
		dekWrapped: envelopeText,
		declaredBytes: z.number().int().min(1).max(16777216),
		ciphertextSha256: hash,
		thumbnailDeclaredBytes: z
			.number()
			.int()
			.min(1)
			.max(16777216)
			.nullable()
			.default(null),
		thumbnailCiphertextSha256: hash.nullable().default(null),
	})
	.superRefine((v, c) => {
		if (
			v.declaredBytes + (v.thumbnailDeclaredBytes ?? 0) > 16777216 ||
			(v.thumbnailDeclaredBytes === null) !==
				(v.thumbnailCiphertextSha256 === null)
		)
			c.addIssue({
				code: "custom",
				message: "Invalid combined bytes or thumbnail parity",
			});
		for (const value of [
			v.filenameCiphertext,
			v.contentTypeCiphertext,
			v.dekWrapped,
		])
			if (Buffer.byteLength(value) > 65536)
				c.addIssue({
					code: "custom",
					message: "Encrypted envelope exceeds byte cap",
				});
	});
const requestSchema = z.strictObject({
	ownerId: identifier,
	jobId: hash,
	ordinal: z.number().int().min(0).max(50000),
	sourceFingerprint: hash,
	expectedRevision: z.number().int().min(0).max(2147483647),
	prepared: preparedSchema,
});
export const attachmentMigrationReservationBodySchema = requestSchema.omit({
	ownerId: true,
	jobId: true,
});
const previousSchema = z.strictObject({
	associationId: z.uuid(),
	attemptId: z.uuid(),
	targetAttachmentId: z
		.string()
		.regex(
			/^migration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		),
	revision: z.number().int().min(1).max(2147483647),
});
const recoverySchema = requestSchema.omit({ expectedRevision: true }).extend({
	previous: previousSchema,
	retireLive: z.boolean(),
});
export const attachmentMigrationRecoveryBodySchema = recoverySchema.omit({
	ownerId: true,
	jobId: true,
});
export type AttachmentMigrationRecovery = z.input<typeof recoverySchema>;
export type AttachmentMigrationReservation = z.input<typeof requestSchema>;
type Prepared = z.output<typeof preparedSchema>;
type Association = {
	id: string;
	owner_user_id: string;
	origin_job_id: string;
	origin_item_ordinal: number;
	import_source_id: string;
	source_attachment_id: string;
	source_metadata: unknown;
	document_digest: string;
	mapping_digest: string;
	plan_digest: string;
	source_fingerprint: string;
	target_workspace_id: string;
	target_parent_kind: "list" | "task" | "comment";
	target_parent_id: string;
	revision: number;
	current_attempt_id: string | null;
	committed_attempt_id: string | null;
	committed_at: Date | null;
};
type Attempt = {
	id: string;
	association_id: string;
	owner_user_id: string;
	revision: number;
	target_attachment_id: string;
	job_id: string;
	key_version: number;
	filename_ciphertext: string;
	content_type_ciphertext: string;
	dek_wrapped: string;
	declared_bytes: string;
	ciphertext_sha256: string;
	thumbnail_declared_bytes: string | null;
	thumbnail_ciphertext_sha256: string | null;
};
type Ordinary = {
	uploaded_by: string;
	workspace_id: string;
	parent_kind: "list" | "task" | "comment";
	parent_id: string;
	key_version: number;
	filename_ciphertext: string;
	content_type_ciphertext: string;
	dek_wrapped: string;
	declared_bytes: string;
	observed_bytes: string | null;
	ciphertext_sha256: string | null;
	thumbnail_declared_bytes: string | null;
	thumbnail_observed_bytes: string | null;
	thumbnail_ciphertext_sha256: string | null;
	deleted_at: Date | null;
	committed_at: Date | null;
	id: string;
	state: string;
	reservation_expires_at: Date | null;
};
function fail(code: string, status = 409): never {
	throw new ImportPlanStoreError(code, status);
}
function preparedFrom(a: Attempt): Prepared {
	return {
		id: a.target_attachment_id,
		keyVersion: a.key_version,
		filenameCiphertext: a.filename_ciphertext,
		contentTypeCiphertext: a.content_type_ciphertext,
		dekWrapped: a.dek_wrapped,
		declaredBytes: Number(a.declared_bytes),
		ciphertextSha256: a.ciphertext_sha256,
		thumbnailDeclaredBytes:
			a.thumbnail_declared_bytes === null
				? null
				: Number(a.thumbnail_declared_bytes),
		thumbnailCiphertextSha256: a.thumbnail_ciphertext_sha256,
	};
}
function validateActiveBinding(p: Association, a: Attempt, f: Ordinary) {
	const bytes = (value: string | null) =>
		value === null ? null : Number(value);
	const observed = bytes(f.observed_bytes);
	const thumbnail = bytes(f.thumbnail_declared_bytes);
	const thumbnailObserved = bytes(f.thumbnail_observed_bytes);
	const expectedThumbnail = bytes(a.thumbnail_declared_bytes);
	if (
		f.id !== a.target_attachment_id ||
		a.association_id !== p.id ||
		a.owner_user_id !== p.owner_user_id ||
		a.revision !== p.revision ||
		a.id !== p.current_attempt_id ||
		f.uploaded_by !== p.owner_user_id ||
		f.workspace_id !== p.target_workspace_id ||
		f.parent_kind !== p.target_parent_kind ||
		f.parent_id !== p.target_parent_id ||
		f.key_version !== a.key_version ||
		f.filename_ciphertext !== a.filename_ciphertext ||
		f.content_type_ciphertext !== a.content_type_ciphertext ||
		f.dek_wrapped !== a.dek_wrapped ||
		bytes(f.declared_bytes) !== bytes(a.declared_bytes) ||
		thumbnail !== expectedThumbnail ||
		f.deleted_at !== null ||
		f.committed_at !== null ||
		(f.state === "reserved"
			? observed !== null || f.ciphertext_sha256 !== null
			: observed !== bytes(a.declared_bytes) ||
				f.ciphertext_sha256 !== a.ciphertext_sha256) ||
		(expectedThumbnail === null
			? thumbnailObserved !== null || f.thumbnail_ciphertext_sha256 !== null
			: (thumbnailObserved === null &&
					f.thumbnail_ciphertext_sha256 !== null) ||
				(thumbnailObserved !== null &&
					(f.state !== "uploading" ||
						thumbnailObserved !== expectedThumbnail ||
						f.thumbnail_ciphertext_sha256 !== a.thumbnail_ciphertext_sha256)))
	)
		fail("migration-attachment-binding-changed");
}
async function authority(client: PoolClient, owner: string, workspace: string) {
	const seats = await client.query<{ role: Role }>(
		"select m.role from membership m join workspace w on w.id=m.workspace_id where m.user_id=$1 and w.id=$2",
		[owner, workspace],
	);
	if (seats.rows.length !== 1 || !WRITE_ROLES.has(seats.rows[0].role))
		fail("not-permitted", 403);
}
function result(p: Association, a: Attempt | null, f: Ordinary | null) {
	return {
		associationId: p.id,
		revision: p.revision,
		attemptId: a?.id ?? null,
		targetAttachmentId: a?.target_attachment_id ?? null,
		committed: p.committed_attempt_id !== null,
		committedAt: p.committed_at,
		attachmentState: f?.state ?? null,
	};
}
async function retained(
	client: PoolClient,
	owner: string,
	jobId: string,
	ordinal: number,
) {
	const found = await client.query<Association>(
		"select * from attachment_migration where owner_user_id=$1 and origin_job_id=$2 and origin_item_ordinal=$3",
		[owner, jobId, ordinal],
	);
	if (found.rows.length > 1) fail("migration-identity-conflict");
	const p = found.rows[0];
	if (!p) return null;
	const discovery = p.current_attempt_id
		? await client.query<Attempt>(
				"select * from attachment_migration_attempt where id=$1 and association_id=$2 and owner_user_id=$3",
				[p.current_attempt_id, p.id, owner],
			)
		: { rows: [] };
	if (p.current_attempt_id && discovery.rows.length !== 1)
		fail("migration-attempt-unavailable");
	const old = discovery.rows[0];
	const file = old
		? await client.query<Ordinary>(
				"select * from attachment where id=$1 for update",
				[old.target_attachment_id],
			)
		: { rows: [] };
	const locked = await client.query<Association>(
		"select * from attachment_migration where id=$1 and owner_user_id=$2 for update",
		[p.id, owner],
	);
	const current = locked.rows[0];
	if (
		locked.rows.length !== 1 ||
		!current ||
		current.current_attempt_id !== p.current_attempt_id ||
		current.revision !== p.revision
	)
		fail("migration-revision-conflict");
	// Attempts are immutable; owner and association locks prevent deletion or rebinding.
	const attempts = old
		? await client.query<Attempt>(
				"select * from attachment_migration_attempt where id=$1 and association_id=$2 and owner_user_id=$3",
				[old.id, p.id, owner],
			)
		: { rows: [] };
	const a = attempts.rows[0];
	if (old && (!a || attempts.rows.length !== 1 || !isDeepStrictEqual(a, old)))
		fail("migration-attempt-unavailable");
	await authority(client, owner, current.target_workspace_id);
	return { p: current, a: a ?? null, f: file.rows[0] ?? null };
}
// Advisory reader derives IDs; SHARE locks freeze non-key placement before revalidation.
async function lockParent(
	client: PoolClient,
	p: NonNullable<
		Awaited<
			ReturnType<typeof readAttachmentMigrationParentOnClient>
		>["parent"]["destinationParent"]
	>,
	owner: string,
	sourceId: string,
	jobId: string,
) {
	const chain = await client.query<{
		list_id: string;
		task_id: string | null;
		comment_id: string | null;
	}>(
		p.kind === "list"
			? "select id as list_id,null::text task_id,null::text comment_id from list where id=$1 and workspace_id=$2"
			: p.kind === "task"
				? "select l.id list_id,t.id task_id,null::text comment_id from task t join list l on l.id=t.list_id where t.id=$1 and l.workspace_id=$2"
				: "select l.id list_id,t.id task_id,c.id comment_id from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id where c.id=$1 and l.workspace_id=$2",
		[p.id, p.workspaceId],
	);
	if (chain.rows.length !== 1) fail("parent-unavailable");
	const ids = chain.rows[0];
	const maps = await client.query<{ source_key: string }>(
		`select m.source_key from import_source_map m join import_item i on i.source_key=m.source_key and i.job_id=$4 and i.target_id=m.target_id where m.source_id=$1 and m.owner_user_id=$2 and m.target_id=$3 and m.collection=$5 order by m.source_key limit 2 for share of m`,
		[
			sourceId,
			owner,
			ids.task_id ?? ids.list_id,
			jobId,
			ids.task_id ? "tasks" : "lists",
		],
	);
	if (maps.rows.length !== 1) fail("parent-unapplied");
	if (
		(
			await client.query(
				"select id from list where id=$1 and workspace_id=$2 for share",
				[ids.list_id, p.workspaceId],
			)
		).rowCount !== 1
	)
		fail("parent-unavailable");
	if (
		ids.task_id &&
		(
			await client.query(
				"select id from task where id=$1 and list_id=$2 for share",
				[ids.task_id, ids.list_id],
			)
		).rowCount !== 1
	)
		fail("parent-changed");
	if (
		ids.comment_id &&
		(
			await client.query(
				"select id from comment where id=$1 and task_id=$2 for share",
				[ids.comment_id, ids.task_id],
			)
		).rowCount !== 1
	)
		fail("parent-changed");
}
export async function reserveAttachmentMigration(
	pool: Pool,
	input: AttachmentMigrationReservation,
	options: {
		quotaBytes?: number;
		reservationTtlMs?: number;
		now?: () => Date;
		signal?: AbortSignal;
	} = {},
) {
	const parsed = requestSchema.safeParse(input);
	if (!parsed.success) fail("invalid-migration-reservation", 400);
	const request = parsed.data;
	const quota = options.quotaBytes ?? 10 * 1024 * 1024 * 1024;
	const ttl = options.reservationTtlMs ?? 60 * 60_000;
	if (
		!Number.isSafeInteger(quota) ||
		quota <= 0 ||
		!Number.isSafeInteger(ttl) ||
		ttl <= 0
	)
		throw new Error("Invalid migration quota or TTL");
	const deadline = performance.now() + 15000;
	const checkpoint = () => {
		if (options.signal?.aborted) fail("import-cancelled", 408);
		if (performance.now() >= deadline) fail("import-timeout", 503);
	};
	try {
		return await importTransaction(
			pool,
			request.ownerId,
			async (client) => {
				const existing = await retained(
					client,
					request.ownerId,
					request.jobId,
					request.ordinal,
				);
				if (existing) {
					const { p, a, f } = existing;
					if (
						p.source_fingerprint !== request.sourceFingerprint ||
						!a ||
						!isDeepStrictEqual(preparedFrom(a), request.prepared)
					)
						fail("migration-preparation-conflict");
					// The original revision-zero request may replay its first acknowledged reservation.
					if (
						request.expectedRevision !== p.revision &&
						!(request.expectedRevision === 0 && p.revision === 1)
					)
						fail("migration-revision-conflict");
					if (p.committed_attempt_id !== null) {
						if (p.committed_attempt_id !== a.id)
							fail("migration-attempt-unavailable");
						return result(p, a, f);
					}
					if (
						!f ||
						!["reserved", "uploading"].includes(f.state) ||
						!f.reservation_expires_at ||
						f.reservation_expires_at.getTime() <=
							(options.now ?? (() => new Date()))().getTime()
					)
						fail("migration-explicit-recovery-required");
					validateActiveBinding(p, a, f);
					return result(p, a, f);
				}
				if (request.expectedRevision !== 0) fail("migration-revision-conflict");
				const before = await readAttachmentMigrationParentOnClient(
					client,
					request.ownerId,
					request.jobId,
					request.ordinal,
					checkpoint,
				);
				if (
					before.parent.sourceAttachmentFingerprint !==
					request.sourceFingerprint
				)
					fail("migration-source-changed");
				const parent = before.parent.destinationParent;
				if (!parent || before.parent.blockedReason)
					fail(before.parent.blockedReason ?? "parent-unavailable");
				try {
					if (
						(
							await client.query(
								"select id from workspace where id=$1 for update nowait",
								[parent.workspaceId],
							)
						).rowCount !== 1
					)
						fail("not-permitted", 403);
				} catch (error) {
					if (
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "55P03"
					)
						fail("migration-workspace-busy");
					throw error;
				}
				const access = await validateAttachmentWrite(
					client,
					request.ownerId,
					{
						workspaceId: parent.workspaceId,
						parentKind: parent.kind,
						parentId: parent.id,
						keyVersion: request.prepared.keyVersion,
					},
					{ lockWorkspace: true, lockContext: true },
				);
				if (access) fail(access, 403);
				await lockParent(
					client,
					parent,
					request.ownerId,
					before.sourceId,
					request.jobId,
				);
				const after = await readAttachmentMigrationParentOnClient(
					client,
					request.ownerId,
					request.jobId,
					request.ordinal,
					checkpoint,
				);
				if (!isDeepStrictEqual(before, after)) fail("migration-parent-changed");
				const v = request.prepared;
				if (
					await attachmentQuotaWouldExceed(
						client,
						parent.workspaceId,
						v.declaredBytes + (v.thumbnailDeclaredBytes ?? 0),
						quota,
					)
				)
					fail("quota-exceeded");
				const associationId = randomUUID(),
					attemptId = randomUUID(),
					now = (options.now ?? (() => new Date()))();
				if (
					!Number.isFinite(now.getTime()) ||
					!Number.isFinite(now.getTime() + ttl)
				)
					throw new Error("Invalid migration clock");
				// No target or identity adoption: any uniqueness conflict rolls back the whole transaction.
				await client.query(
					`insert into attachment_migration(id,owner_user_id,import_source_id,source_attachment_id,source_fingerprint,source_metadata,origin_job_id,origin_item_ordinal,document_digest,mapping_digest,plan_digest,target_workspace_id,target_parent_kind,target_parent_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
					[
						associationId,
						request.ownerId,
						before.sourceId,
						before.sourceAttachment.id,
						request.sourceFingerprint,
						before.sourceAttachment,
						request.jobId,
						request.ordinal,
						before.documentDigest,
						before.mappingDigest,
						before.planDigest,
						parent.workspaceId,
						parent.kind,
						parent.id,
					],
				);
				await client.query(
					`insert into attachment_migration_attempt(id,association_id,owner_user_id,revision,target_attachment_id,job_id,key_version,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,ciphertext_sha256,thumbnail_declared_bytes,thumbnail_ciphertext_sha256) values($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
					[
						attemptId,
						associationId,
						request.ownerId,
						v.id,
						request.jobId,
						v.keyVersion,
						v.filenameCiphertext,
						v.contentTypeCiphertext,
						v.dekWrapped,
						v.declaredBytes,
						v.ciphertextSha256,
						v.thumbnailDeclaredBytes,
						v.thumbnailCiphertextSha256,
					],
				);
				await client.query(
					`insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,thumbnail_declared_bytes,storage_key,thumbnail_storage_key,uploaded_by,reservation_expires_at) values($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
					[
						v.id,
						parent.workspaceId,
						parent.kind,
						parent.id,
						v.keyVersion,
						v.filenameCiphertext,
						v.contentTypeCiphertext,
						v.dekWrapped,
						v.declaredBytes,
						v.thumbnailDeclaredBytes,
						storageKeyFor(parent.workspaceId, v.id),
						v.thumbnailDeclaredBytes === null
							? null
							: storageKeyFor(parent.workspaceId, v.id, "thumbnail"),
						request.ownerId,
						new Date(now.getTime() + ttl),
					],
				);
				if (
					(
						await client.query(
							"update attachment_migration set revision=1,current_attempt_id=$2 where id=$1 and owner_user_id=$3 and revision=0 returning *",
							[associationId, attemptId, request.ownerId],
						)
					).rowCount !== 1
				)
					fail("migration-revision-conflict");
				return {
					associationId,
					revision: 1,
					attemptId,
					targetAttachmentId: v.id,
					committed: false,
					committedAt: null,
					attachmentState: "reserved",
				};
			},
			options.signal,
			deadline,
		);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "23505" &&
			"constraint" in error
		) {
			if (error.constraint === "attachment_migration_identity")
				fail("migration-identity-conflict");
			if (
				error.constraint === "attachment_migration_attempt_target" ||
				error.constraint === "attachment_pkey"
			)
				fail("migration-target-conflict");
		}
		throw error;
	}
}
export async function getAttachmentMigrationStatus(
	pool: Pool,
	ownerId: string,
	jobId: string,
	ordinal: number,
	options: { signal?: AbortSignal } = {},
) {
	if (
		!identifier.safeParse(ownerId).success ||
		!hash.safeParse(jobId).success ||
		!z.number().int().min(0).max(50000).safeParse(ordinal).success
	)
		fail("invalid-migration-status", 400);
	return importTransaction(
		pool,
		ownerId,
		async (client) => {
			const value = await retained(client, ownerId, jobId, ordinal);
			if (!value) fail("migration-not-found", 404);
			return result(value.p, value.a, value.f);
		},
		options.signal,
	);
}

type Retained = NonNullable<Awaited<ReturnType<typeof retained>>>;
type Evidence = Awaited<
	ReturnType<typeof readAttachmentMigrationParentOnClient>
>;
function destination(p: Association) {
	return {
		kind: p.target_parent_kind,
		id: p.target_parent_id,
		workspaceId: p.target_workspace_id,
	};
}
function checkReceipt({ p, a }: Retained) {
	if (
		!a ||
		a.association_id !== p.id ||
		a.owner_user_id !== p.owner_user_id ||
		a.id !== p.current_attempt_id ||
		a.revision !== p.revision ||
		a.job_id !== p.origin_job_id ||
		(p.committed_attempt_id === null) !== (p.committed_at === null) ||
		(p.committed_attempt_id !== null && p.committed_attempt_id !== a.id)
	)
		fail("migration-attempt-unavailable");
	return a;
}
function checkProvenance(p: Association, evidence: Evidence) {
	if (
		p.import_source_id !== evidence.sourceId ||
		p.document_digest !== evidence.documentDigest ||
		p.mapping_digest !== evidence.mappingDigest ||
		p.plan_digest !== evidence.planDigest ||
		p.source_attachment_id !== evidence.sourceAttachment.id ||
		p.source_fingerprint !== evidence.parent.sourceAttachmentFingerprint ||
		!isDeepStrictEqual(p.source_metadata, evidence.sourceAttachment)
	)
		fail("migration-source-changed");
}
function checkDestination(p: Association, evidence: Evidence) {
	if (!evidence.parent.destinationParent || evidence.parent.blockedReason)
		fail(evidence.parent.blockedReason ?? "parent-unavailable");
	if (!isDeepStrictEqual(destination(p), evidence.parent.destinationParent))
		fail("migration-parent-changed");
}
function active(value: Retained, now: Date) {
	return (
		value.f !== null &&
		["reserved", "uploading"].includes(value.f.state) &&
		value.f.reservation_expires_at !== null &&
		value.f.reservation_expires_at > now
	);
}
function inspection(value: Retained, recoverable: boolean) {
	checkReceipt(value);
	const p = value.p;
	return {
		...result(p, value.a, value.f),
		ownerId: p.owner_user_id,
		jobId: p.origin_job_id,
		sourceId: p.import_source_id,
		documentDigest: p.document_digest,
		mappingDigest: p.mapping_digest,
		planDigest: p.plan_digest,
		sourceFingerprint: p.source_fingerprint,
		destinationParent: destination(p),
		reservationExpiresAt: value.f?.reservation_expires_at ?? null,
		recoverable,
	};
}
async function inspectRetained(
	client: PoolClient,
	value: Retained,
	checkpoint: () => void,
) {
	checkReceipt(value);
	if (value.p.committed_attempt_id !== null) return inspection(value, false);
	const evidence = await readAttachmentMigrationParentOnClient(
		client,
		value.p.owner_user_id,
		value.p.origin_job_id,
		value.p.origin_item_ordinal,
		checkpoint,
	);
	checkProvenance(value.p, evidence);
	const sameParent =
		evidence.parent.blockedReason === null &&
		isDeepStrictEqual(destination(value.p), evidence.parent.destinationParent);
	const keys = await client.query<{ version: number }>(
		"select wk.version from workspace_key wk join membership_key mk on mk.workspace_id=wk.workspace_id and mk.key_version=wk.version join membership m on m.id=mk.membership_id and m.user_id=mk.user_id join workspace w on w.id=wk.workspace_id where wk.workspace_id=$1 and wk.active and mk.user_id=$2 and not w.rotation_required",
		[value.p.target_workspace_id, value.p.owner_user_id],
	);
	return inspection(
		value,
		sameParent &&
			!active(value, new Date()) &&
			keys.rows.length === 1 &&
			(value.f === null ||
				["reserved", "uploading", "aborted"].includes(value.f.state)),
	);
}
function migrationCheckpoint(
	signal: AbortSignal | undefined,
	deadline: number,
) {
	return () => {
		if (signal?.aborted) fail("import-cancelled", 408);
		if (performance.now() >= deadline) fail("import-timeout", 503);
	};
}
export async function inspectAttachmentMigration(
	pool: Pool,
	ownerId: string,
	jobId: string,
	ordinal: number,
	options: { signal?: AbortSignal } = {},
) {
	if (
		!identifier.safeParse(ownerId).success ||
		!hash.safeParse(jobId).success ||
		!z.number().int().min(0).max(50000).safeParse(ordinal).success
	)
		fail("invalid-migration-status", 400);
	const deadline = performance.now() + 15000;
	const checkpoint = migrationCheckpoint(options.signal, deadline);
	return importTransaction(
		pool,
		ownerId,
		async (client) => {
			const value = await retained(client, ownerId, jobId, ordinal);
			if (!value) fail("migration-not-found", 404);
			return inspectRetained(client, value, checkpoint);
		},
		options.signal,
		deadline,
	);
}

async function lockRecoveryContext(
	client: PoolClient,
	p: Association,
	keyVersion: number,
	checkpoint: () => void,
) {
	const before = await readAttachmentMigrationParentOnClient(
		client,
		p.owner_user_id,
		p.origin_job_id,
		p.origin_item_ordinal,
		checkpoint,
	);
	checkProvenance(p, before);
	checkDestination(p, before);
	const parent = destination(p);
	try {
		if (
			(
				await client.query(
					"select id from workspace where id=$1 for update nowait",
					[parent.workspaceId],
				)
			).rowCount !== 1
		)
			fail("not-permitted", 403);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "55P03"
		)
			fail("migration-workspace-busy");
		throw error;
	}
	const access = await validateAttachmentWrite(
		client,
		p.owner_user_id,
		{
			workspaceId: parent.workspaceId,
			parentKind: parent.kind,
			parentId: parent.id,
			keyVersion: keyVersion,
		},
		{ lockWorkspace: true, lockContext: true },
	);
	if (access) fail(access, 403);
	await lockParent(
		client,
		parent,
		p.owner_user_id,
		before.sourceId,
		p.origin_job_id,
	);
	const after = await readAttachmentMigrationParentOnClient(
		client,
		p.owner_user_id,
		p.origin_job_id,
		p.origin_item_ordinal,
		checkpoint,
	);
	if (!isDeepStrictEqual(before, after)) fail("migration-parent-changed");

	return parent;
}

export async function recoverAttachmentMigration(
	pool: Pool,
	input: AttachmentMigrationRecovery,
	options: {
		quotaBytes?: number;
		reservationTtlMs?: number;
		now?: () => Date;
		signal?: AbortSignal;
	} = {},
) {
	const parsed = recoverySchema.safeParse(input);
	if (!parsed.success) fail("invalid-migration-recovery", 400);
	const request = parsed.data;
	const quota = options.quotaBytes ?? 10 * 1024 * 1024 * 1024;
	const ttl = options.reservationTtlMs ?? 60 * 60_000;
	const now = (options.now ?? (() => new Date()))();
	if (
		!Number.isSafeInteger(quota) ||
		quota <= 0 ||
		!Number.isSafeInteger(ttl) ||
		ttl <= 0 ||
		!Number.isFinite(now.getTime()) ||
		!Number.isFinite(now.getTime() + ttl)
	)
		throw new Error("Invalid migration quota, TTL or clock");
	const deadline = performance.now() + 15000;
	const checkpoint = migrationCheckpoint(options.signal, deadline);
	try {
		return await importTransaction(
			pool,
			request.ownerId,
			async (client) => {
				const value = await retained(
					client,
					request.ownerId,
					request.jobId,
					request.ordinal,
				);
				if (!value) fail("migration-not-found", 404);
				const { p, f } = value;
				const a = checkReceipt(value);
				if (p.source_fingerprint !== request.sourceFingerprint)
					fail("migration-source-changed");
				if (p.committed_attempt_id !== null)
					return {
						outcome: "committed" as const,
						status: inspection(value, false),
					};
				const previous = request.previous;
				if (p.id !== previous.associationId)
					fail("migration-revision-conflict");
				const witness = await client.query<Attempt>(
					"select * from attachment_migration_attempt where id=$1 and association_id=$2 and owner_user_id=$3 and revision=$4 and target_attachment_id=$5",
					[
						previous.attemptId,
						p.id,
						request.ownerId,
						previous.revision,
						previous.targetAttachmentId,
					],
				);
				if (witness.rows.length !== 1) fail("migration-revision-conflict");
				if (
					p.revision === previous.revision + 1 &&
					isDeepStrictEqual(preparedFrom(a), request.prepared)
				) {
					if (active(value, now) && f) {
						validateActiveBinding(p, a, f);
						await lockRecoveryContext(client, p, a.key_version, checkpoint);
						return {
							outcome: "reserved" as const,
							status: inspection(value, false),
						};
					}
					return {
						outcome: "recovery-required" as const,
						status: await inspectRetained(client, value, checkpoint),
					};
				}
				if (
					p.revision !== previous.revision ||
					a.id !== previous.attemptId ||
					a.target_attachment_id !== previous.targetAttachmentId
				)
					fail("migration-revision-conflict");
				if (p.revision === 2147483647) fail("migration-revision-conflict");
				if (request.prepared.id === a.target_attachment_id)
					fail("migration-preparation-conflict");
				if (f) {
					if (!["reserved", "uploading", "aborted"].includes(f.state))
						fail("migration-attachment-binding-changed");
					if (
						f.uploaded_by !== p.owner_user_id ||
						f.workspace_id !== p.target_workspace_id ||
						f.parent_kind !== p.target_parent_kind ||
						f.parent_id !== p.target_parent_id ||
						f.key_version !== a.key_version ||
						f.filename_ciphertext !== a.filename_ciphertext ||
						f.content_type_ciphertext !== a.content_type_ciphertext ||
						f.dek_wrapped !== a.dek_wrapped ||
						Number(f.declared_bytes) !== Number(a.declared_bytes) ||
						f.thumbnail_declared_bytes !== a.thumbnail_declared_bytes ||
						f.deleted_at !== null ||
						f.committed_at !== null
					)
						fail("migration-attachment-binding-changed");
					if (["reserved", "uploading"].includes(f.state)) {
						if (!f.reservation_expires_at)
							fail("migration-attachment-binding-changed");
						validateActiveBinding(p, a, f);
					}
					if (active(value, now) && !request.retireLive)
						fail("migration-live-retirement-required");
				}
				const parent = await lockRecoveryContext(
					client,
					p,
					request.prepared.keyVersion,
					checkpoint,
				);
				const v = request.prepared;
				if (
					await attachmentQuotaWouldExceed(
						client,
						parent.workspaceId,
						v.declaredBytes + (v.thumbnailDeclaredBytes ?? 0),
						quota,
					)
				)
					fail("quota-exceeded");
				if (f && ["reserved", "uploading", "aborted"].includes(f.state))
					await client.query(
						"update attachment set state='aborted',reservation_expires_at=$2 where id=$1",
						[a.target_attachment_id, now],
					);
				const attemptId = randomUUID();
				await client.query(
					`insert into attachment_migration_attempt(id,association_id,owner_user_id,revision,target_attachment_id,job_id,key_version,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,ciphertext_sha256,thumbnail_declared_bytes,thumbnail_ciphertext_sha256) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
					[
						attemptId,
						p.id,
						request.ownerId,
						p.revision + 1,
						v.id,
						request.jobId,
						v.keyVersion,
						v.filenameCiphertext,
						v.contentTypeCiphertext,
						v.dekWrapped,
						v.declaredBytes,
						v.ciphertextSha256,
						v.thumbnailDeclaredBytes,
						v.thumbnailCiphertextSha256,
					],
				);
				await client.query(
					`insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,thumbnail_declared_bytes,storage_key,thumbnail_storage_key,uploaded_by,reservation_expires_at) values($1,$2,$3,$4,$5,'reserved',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
					[
						v.id,
						parent.workspaceId,
						parent.kind,
						parent.id,
						v.keyVersion,
						v.filenameCiphertext,
						v.contentTypeCiphertext,
						v.dekWrapped,
						v.declaredBytes,
						v.thumbnailDeclaredBytes,
						storageKeyFor(parent.workspaceId, v.id),
						v.thumbnailDeclaredBytes === null
							? null
							: storageKeyFor(parent.workspaceId, v.id, "thumbnail"),
						request.ownerId,
						new Date(now.getTime() + ttl),
					],
				);
				const updated = await client.query<Association>(
					"update attachment_migration set revision=revision+1,current_attempt_id=$2 where id=$1 and owner_user_id=$3 and revision=$4 and current_attempt_id=$5 and committed_attempt_id is null returning *",
					[p.id, attemptId, request.ownerId, p.revision, a.id],
				);
				if (updated.rows.length !== 1) fail("migration-revision-conflict");
				const attempt = (
					await client.query<Attempt>(
						"select * from attachment_migration_attempt where id=$1",
						[attemptId],
					)
				).rows[0];
				const file = (
					await client.query<Ordinary>("select * from attachment where id=$1", [
						v.id,
					])
				).rows[0];
				return {
					outcome: "reserved" as const,
					status: inspection(
						{ p: updated.rows[0], a: attempt, f: file },
						false,
					),
				};
			},
			options.signal,
			deadline,
		);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "23505"
		)
			fail("migration-target-conflict");
		throw error;
	}
}
