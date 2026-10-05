import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	bindWebhookTask,
	canonicalWebhookDelivery,
	parseWebhookCreate,
	validWebhookSecret,
	WEBHOOK_ACTIVE_LIMIT,
	WEBHOOK_PREFIX,
	type WebhookDelivery,
} from "../../domain/public-api-webhook.ts";
import {
	type CollectedEvent,
	withEventCollector,
} from "../notifications/events.ts";
import { withPersonalAccessToken } from "./tokens.ts";
import {
	createApiTaskTx,
	type FlushApiEvents,
	flushApiEvents,
} from "./write.ts";

type WebhookMetadata = {
	id: string;
	name: string;
	hint: string;
	listId: string;
	workspaceId: string;
	createdAt: Date;
	expiresAt: Date;
	revokedAt: Date | null;
};
const fields = `id,name,hint,list_id as "listId",workspace_id as "workspaceId",created_at as "createdAt",expires_at as "expiresAt",revoked_at as "revokedAt"`;
const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const unauthorized = () =>
	new PublicApiError(
		401,
		"unauthorized",
		"A valid webhook credential is required",
	);
const notFound = () =>
	new PublicApiError(404, "not-found", "Resource not found");
const unavailable = () =>
	new PublicApiError(503, "temporarily-unavailable", "Try again shortly");

// Lock order everywhere: user rows (sorted), workspace, membership, list, then the hook row.
async function lockScope(
	client: PoolClient,
	userId: string,
	listId: string,
	workspaceId: string,
): Promise<string> {
	const workspace = await client.query(
		"select id from workspace where id=$1 for share",
		[workspaceId],
	);
	const membership = await client.query<{ role: string }>(
		"select role from membership where user_id=$1 and workspace_id=$2 for share",
		[userId, workspaceId],
	);
	const list = await client.query(
		"select id from list where id=$1 and workspace_id=$2 for share",
		[listId, workspaceId],
	);
	if (
		workspace.rowCount !== 1 ||
		membership.rowCount !== 1 ||
		list.rowCount !== 1
	)
		throw notFound();
	return membership.rows[0].role;
}

export async function createWebhook(
	pool: Pool,
	token: string | null,
	input: unknown,
): Promise<Response> {
	const parsed = parseWebhookCreate(input);
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			const list = await client.query<{ workspaceId: string }>(
				`select l.workspace_id as "workspaceId" from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2`,
				[parsed.listId, actor.userId],
			);
			if (list.rowCount !== 1) throw notFound();
			const workspaceId = list.rows[0].workspaceId;
			const role = await lockScope(
				client,
				actor.userId,
				parsed.listId,
				workspaceId,
			);
			if (role === "viewer")
				throw new PublicApiError(
					403,
					"forbidden",
					"This workspace role cannot create tasks",
				);
			// The actor row is already locked FOR UPDATE, which serializes this count.
			const count = await client.query<{ count: number }>(
				"select count(*)::integer count from inbound_webhook where user_id=$1 and revoked_at is null and expires_at>statement_timestamp()",
				[actor.userId],
			);
			if (count.rows[0].count >= WEBHOOK_ACTIVE_LIMIT)
				throw new PublicApiError(
					409,
					"webhook-limit",
					"Revoke an active webhook before creating another",
				);
			const secret = `${WEBHOOK_PREFIX}${randomBytes(32).toString("base64url")}`;
			const result = await client.query<WebhookMetadata>(
				`insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,statement_timestamp(),statement_timestamp()+make_interval(days=>$8)) returning ${fields}`,
				[
					randomUUID(),
					actor.userId,
					parsed.listId,
					workspaceId,
					parsed.name,
					sha256(secret),
					secret.slice(-4),
					parsed.expiresInDays,
				],
			);
			return apiResult({ ...result.rows[0], secret }, null, 201);
		},
	);
}

export async function listWebhooks(
	pool: Pool,
	token: string | null,
): Promise<Response> {
	return withPersonalAccessToken(pool, token, "write", async (client, actor) =>
		apiResult(
			(
				await client.query<WebhookMetadata>(
					`select ${fields} from inbound_webhook where user_id=$1 order by (revoked_at is null and expires_at>statement_timestamp()) desc,created_at desc,id limit 100`,
					[actor.userId],
				)
			).rows,
		),
	);
}

export async function revokeWebhook(
	pool: Pool,
	token: string | null,
	id: string,
): Promise<Response> {
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			const row = await client.query(
				"update inbound_webhook set revoked_at=coalesce(revoked_at,statement_timestamp()) where id=$1 and user_id=$2 returning id",
				[id, actor.userId],
			);
			if (row.rowCount !== 1) throw notFound();
			return apiResult({ id, revoked: true });
		},
	);
}

const activeHook = `revoked_at is null and expires_at>`;

export async function deliverWebhook(
	pool: Pool,
	secret: string | null,
	routeId: string,
	delivery: WebhookDelivery,
	flush?: FlushApiEvents,
): Promise<Response> {
	if (!secret || !validWebhookSecret(secret)) throw unauthorized();
	const hash = sha256(secret);
	const events: CollectedEvent[] = [];
	const client = await pool.connect();
	let response: Response;
	try {
		await client.query("begin");
		await client.query(
			"select set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),set_config('ditero.webhook_hash',$1,true)",
			[hash],
		);
		const initial = await client.query<{
			id: string;
			userId: string;
			listId: string;
			workspaceId: string;
		}>(
			`select id,user_id as "userId",list_id as "listId",workspace_id as "workspaceId" from inbound_webhook where secret_hash=$1 and ${activeHook}statement_timestamp()`,
			[hash],
		);
		const hook = initial.rows[0];
		// The route id only addresses the hook; the credential decides.
		if (!hook || hook.id !== routeId.toLowerCase()) throw unauthorized();
		await client.query(
			"select set_config('ditero.user_id',$1,true),set_config('ditero.webhook_hash','',true)",
			[hook.userId],
		);
		const observed = await client.query<{ ownerId: string }>(
			`select l.owner_id as "ownerId" from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and l.workspace_id=$2 and m.user_id=$3`,
			[hook.listId, hook.workspaceId, hook.userId],
		);
		const ownerId = observed.rows[0]?.ownerId;
		if (!ownerId) throw notFound();
		for (const id of [...new Set([hook.userId, ownerId])].sort()) {
			const live = await client.query(
				'select id from "user" where id=$1 and deleted_at is null for update',
				[id],
			);
			if (live.rowCount !== 1)
				throw id === hook.userId ? unauthorized() : notFound();
		}
		const role = await lockScope(
			client,
			hook.userId,
			hook.listId,
			hook.workspaceId,
		);
		const locked = await client.query<{ ownerId: string }>(
			`select owner_id as "ownerId" from list where id=$1 and workspace_id=$2`,
			[hook.listId, hook.workspaceId],
		);
		if (locked.rows[0]?.ownerId !== ownerId) throw unavailable();
		const hookValid = (clock: string, lock: string) =>
			client.query(
				`select id from inbound_webhook where id=$1 and user_id=$2 and list_id=$3 and workspace_id=$4 and secret_hash=$5 and ${activeHook}${clock}${lock}`,
				[hook.id, hook.userId, hook.listId, hook.workspaceId, hash],
			);
		// Validated on every request, including replays, before any receipt is read.
		if ((await hookValid("statement_timestamp()", " for share")).rowCount !== 1)
			throw unauthorized();
		if (role === "viewer")
			throw new PublicApiError(
				403,
				"forbidden",
				"This webhook can no longer create tasks",
			);
		const task = bindWebhookTask(delivery.task, hook.listId);
		const { taskId, replayed } = await withEventCollector(events, () =>
			createApiTaskTx(
				client,
				hook.userId,
				task,
				delivery.deliveryId,
				sha256(canonicalWebhookDelivery(hook.id, task)),
				true,
			),
		);
		if (replayed) {
			// A moved task is as gone to this webhook as a deleted one; the message never says where.
			const exists = await client.query(
				"select id from task where id=$1 and list_id=$2",
				[taskId, hook.listId],
			);
			if (!exists.rowCount)
				throw new PublicApiError(
					410,
					"task-deleted",
					"The task created by this delivery is no longer in this webhook's list",
				);
		}
		if ((await hookValid("clock_timestamp()", "")).rowCount !== 1)
			throw unauthorized();
		await client.query("commit");
		response = apiResult(
			{ id: taskId, listId: hook.listId, replayed },
			null,
			replayed ? 200 : 201,
		);
	} catch (error) {
		await client.query("rollback").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
	await flushApiEvents(pool, events, flush);
	return response;
}
