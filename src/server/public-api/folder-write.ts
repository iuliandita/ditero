import { createHash, randomUUID } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiFolderCreate,
	canonicalApiFolderCreate,
} from "../../domain/public-api-folder.ts";
import {
	type ApiFolder,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroContainerWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { visibleFolderSnapshot } from "./folder-observation.ts";
import { type ApiActor, withPersonalAccessToken } from "./tokens.ts";
export const folderDatabase = (client: PoolClient) =>
	new ZQLDatabase(
		{
			transaction: async (callback) =>
				callback(new NodePgTransactionInternal(client)),
		},
		schema,
	);
const notFound = () =>
	new PublicApiError(404, "not-found", "Resource not found");
const forbidden = () =>
	new PublicApiError(
		403,
		"forbidden",
		"This workspace role cannot write folders",
	);
export function translateFolderError(error: unknown): never {
	if (error instanceof Error) {
		if (error.message === "List is waiting for import activation")
			throw new PublicApiError(
				409,
				"activation-pending",
				"Complete import activation before renaming this folder",
			);
		if (error.message === "folder not empty")
			throw new PublicApiError(
				409,
				"folder-not-empty",
				"Only empty folders can be deleted",
			);
		if (error.message === "access denied: need member+") throw forbidden();
		if (
			error.message === "Activation container not found" ||
			error.message === "folder not found"
		)
			throw notFound();
		if (/^Activation .+ changed$/.test(error.message))
			throw new PublicApiError(
				503,
				"temporarily-unavailable",
				"Try again shortly",
			);
	}
	throw error;
}
type FolderWriteOptions = {
	workspaceId: string;
	folderId?: string;
	canonical: string;
	kind: "folder-create-ack" | "folder-update-ack" | "folder-delete-ack";
	patch?: { name: string };
};
export function withFolderWrite(
	pool: Pool,
	token: string | null,
	requestId: string,
	options: FolderWriteOptions,
	mutate: (client: PoolClient, actor: ApiActor) => Promise<ApiFolder>,
): Promise<Response> {
	let role: string | null = null;
	let authorityProblem: PublicApiError | null = null;
	let folderLocked = false;
	const hash = createHash("sha256").update(options.canonical).digest("hex");
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			if (authorityProblem) throw authorityProblem;
			if (!role) throw notFound();
			if (!["member", "admin", "owner"].includes(role)) throw forbidden();
			const receipt = await client.query<{
				request_hash: string;
				resource_kind: string;
				folder_id: string | null;
				folder_snapshot: unknown;
			}>(
				"select request_hash,resource_kind,folder_id,folder_snapshot from public_api_request where user_id=$1 and request_id=$2",
				[actor.userId, requestId],
			);
			if (receipt.rowCount) {
				const stored = receipt.rows[0];
				if (stored.resource_kind !== "folder" || stored.request_hash !== hash)
					throw new PublicApiError(
						409,
						"idempotency-conflict",
						"This Idempotency-Key was used for a different request",
					);
				const snapshot = publicApiResourceSchemas.folders.parse(
					stored.folder_snapshot,
				);
				if (
					snapshot.id !== stored.folder_id ||
					snapshot.workspaceId !== options.workspaceId ||
					(options.folderId !== undefined && snapshot.id !== options.folderId)
				)
					throw new Error("Invalid folder receipt");
				return apiResult({ kind: options.kind, snapshot });
			}
			if (options.folderId !== undefined && !folderLocked) throw notFound();
			const snapshot = publicApiResourceSchemas.folders.parse(
				await mutate(client, actor),
			);
			if (
				snapshot.workspaceId !== options.workspaceId ||
				(options.folderId !== undefined && snapshot.id !== options.folderId)
			)
				throw new Error("Invalid folder mutation result");
			await client.query(
				"insert into public_api_request(user_id,request_id,request_hash,resource_kind,folder_id,folder_snapshot) values($1,$2,$3,'folder',$4,$5::jsonb)",
				[actor.userId, requestId, hash, snapshot.id, JSON.stringify(snapshot)],
			);
			return apiResult(
				{ kind: options.kind, snapshot },
				null,
				options.folderId === undefined ? 201 : 200,
			);
		},
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			const live = await client.query(
				'select id from "user" where id=$1 and deleted_at is null for update',
				[userId],
			);
			if (!live.rowCount) return;
			const workspace = await client.query(
				`select id from workspace where id=$1 for ${options.folderId === undefined ? "update" : "share"}`,
				[options.workspaceId],
			);
			const membership = await client.query<{ role: string }>(
				"select role from membership where workspace_id=$1 and user_id=$2 for share",
				[options.workspaceId, userId],
			);
			if (!workspace.rowCount || !membership.rowCount) return;
			role = membership.rows[0].role;
			if (!["member", "admin", "owner"].includes(role)) {
				authorityProblem = forbidden();
				return;
			}
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1, 0))",
				[JSON.stringify(["public-api-task-create", userId, requestId])],
			);
			if (
				options.folderId === undefined ||
				(
					await client.query(
						"select request_id from public_api_request where user_id=$1 and request_id=$2",
						[userId, requestId],
					)
				).rowCount
			)
				return;
			const current = await visibleFolderSnapshot(
				client,
				userId,
				options.folderId,
			);
			if (!current || current.snapshot.workspaceId !== options.workspaceId)
				return;
			try {
				await folderDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroContainerWrite(tx, userId, {
							folderId: options.folderId,
							...(options.patch
								? { folderPatch: options.patch }
								: { allowPending: true }),
						}),
					),
				);
				folderLocked = true;
			} catch (error) {
				try {
					translateFolderError(error);
				} catch (translated) {
					if (!(translated instanceof PublicApiError)) throw translated;
					authorityProblem = translated;
				}
			}
		},
	);
}
export function writeApiFolder(
	pool: Pool,
	token: string | null,
	input: ApiFolderCreate,
	requestId: string,
): Promise<Response> {
	return withFolderWrite(
		pool,
		token,
		requestId,
		{
			workspaceId: input.workspaceId,
			canonical: canonicalApiFolderCreate(input),
			kind: "folder-create-ack",
		},
		async (client, actor) => {
			const id = randomUUID();
			const last = await client.query<{ sort_key: string }>(
				'select sort_key from folder where workspace_id=$1 order by sort_key collate "C" desc limit 1',
				[input.workspaceId],
			);
			await folderDatabase(client).transaction((tx) =>
				withZeroUserContext(tx, actor.userId, () =>
					mutators.folder.create.fn({
						tx,
						ctx: { id: actor.userId },
						args: {
							id,
							workspaceId: input.workspaceId,
							name: input.name,
							sortKey: keyBetween(last.rows[0]?.sort_key ?? null, null),
						},
					}),
				),
			);
			const created = await visibleFolderSnapshot(client, actor.userId, id);
			if (!created) throw notFound();
			return created.snapshot;
		},
	);
}
