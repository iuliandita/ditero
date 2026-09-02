import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import * as tables from "../../src/db/schema.ts";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import { attachmentRoutes } from "../../src/server/attachments/routes.ts";
import { attachmentSweep } from "../../src/server/attachments/sweep.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import { enqueueEvents } from "../../src/server/notifications/events.ts";
import {
	BlobNotFoundError,
	type BlobStore,
} from "../../src/server/storage/blob-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const DELETE_ME = "account-delete-me";
const REMAINING = "account-delete-remaining";
const PERSONAL = "account-delete-personal";
const SHARED = "account-delete-shared";
const PERSONAL_ATTACHMENT = "account-delete-personal-file";
const SHARED_ATTACHMENT = "account-delete-shared-file";
const PERSONAL_TASK = "account-delete-personal-task";
const SHARED_TASK = "account-delete-shared-task";
const NOW = new Date("2026-09-02T14:00:00.000Z");
const ORIGINAL_EMAIL = "delete-me@example.test";
const previousE2EEnabled = process.env.DITERO_E2E_ENABLED;

class MemoryBlobStore implements BlobStore {
	readonly objects = new Map<string, Uint8Array>();

	async put(key: string, body: AsyncIterable<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		for await (const chunk of body) chunks.push(chunk);
		const value = Buffer.concat(chunks);
		this.objects.set(key, value);
		return {
			bytes: value.byteLength,
			sha256: createHash("sha256").update(value).digest("hex"),
		};
	}

	async get(key: string): Promise<AsyncIterable<Uint8Array>> {
		const value = this.objects.get(key);
		if (!value) throw new BlobNotFoundError(key);
		return (async function* () {
			yield value;
		})();
	}

	async delete(key: string) {
		this.objects.delete(key);
	}

	async exists(key: string) {
		return this.objects.has(key);
	}
}

const store = new MemoryBlobStore();
const guards: Guards = {
	foreignOrigin: () => false,
	guardedPost:
		(handler) =>
		async ({ request }) => {
			const userId = request.headers.get("x-test-user");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			return await handler(request, {
				user: { id: userId },
			} as unknown as Session);
		},
	guardedGet:
		(handler) =>
		async ({ request }) => {
			const userId = request.headers.get("x-test-user");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			return await handler(request, {
				user: { id: userId },
			} as unknown as Session);
		},
};

const app = new Elysia()
	.use(
		accountDeletionRoutes(pool, guards, {
			now: () => new Date(NOW),
			deletedEmail: () => "deleted-account@example.invalid",
		}),
	)
	.use(attachmentRoutes(pool, guards, store));

function request(path: string, userId = DELETE_ME, body?: unknown) {
	return app.handle(
		new Request(`http://localhost${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				"x-test-user": userId,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}

async function count(table: string, column: string, value: string) {
	const result = await pool.query<{ count: string }>(
		`select count(*)::text as count from ${table} where ${column} = $1`,
		[value],
	);
	return Number(result.rows[0]?.count ?? 0);
}

async function seed(otherHolder = false) {
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1, 'Delete Me', $2, true, now(), now()),
		        ($3, 'Remaining Member', 'remaining@example.test', true, now(), now())`,
		[DELETE_ME, ORIGINAL_EMAIL, REMAINING],
	);
	await pool.query(
		`insert into account
		 (id, account_id, provider_id, user_id, password, created_at, updated_at)
		 values ('account-delete-credential', $1, 'credential', $1, 'hash', now(), now())`,
		[DELETE_ME],
	);
	await pool.query(
		`insert into session
		 (id, expires_at, token, created_at, updated_at, user_id)
		 values ('account-delete-session', now() + interval '1 day',
		         'account-delete-token', now(), now(), $1)`,
		[DELETE_ME],
	);
	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Private files', $3, 'personal'),
		        ($2, 'Shared files', $3, 'shared')`,
		[PERSONAL, SHARED, DELETE_ME],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role)
		 values ('account-delete-personal-seat', $1, $3, 'owner'),
		        ('account-delete-shared-owner', $1, $4, 'owner'),
		        ('account-delete-shared-member', $2, $4, 'owner')`,
		[DELETE_ME, REMAINING, PERSONAL, SHARED],
	);
	await pool.query(
		`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
		 values ('account-delete-personal-list', $1, $3, 'Private', 'tasks', 'a'),
		        ('account-delete-shared-list', $2, $3, 'Shared', 'tasks', 'a')`,
		[PERSONAL, SHARED, DELETE_ME],
	);
	await pool.query(
		`insert into task (id, list_id, title, sort_key)
		 values ($1, 'account-delete-personal-list', 'Private task', 'a'),
		        ($2, 'account-delete-shared-list', 'Quarterly close', 'a')`,
		[PERSONAL_TASK, SHARED_TASK],
	);
	await pool.query(
		`insert into user_key (id, user_id, public_key, state)
		 values ('account-delete-user-key', $1, 'delete-public-key', 'ready'),
		        ('account-delete-remaining-key', $2, 'remaining-public-key', 'ready')`,
		[DELETE_ME, REMAINING],
	);
	await pool.query(
		`insert into user_key_secret
		 (user_key_id, user_id, passphrase_wrapped, recovery_wrapped,
		  passphrase_salt, recovery_salt, format_version)
		 values ('account-delete-user-key', $1, 'p', 'r', 'ps', 'rs', 1)`,
		[DELETE_ME],
	);
	await pool.query(
		`insert into workspace_key
		 (id, workspace_id, version, commitment, minted_by)
		 values ('account-delete-personal-wk', $1, 1, 'personal-commitment', $3),
		        ('account-delete-shared-wk', $2, 1, 'shared-commitment', $3)`,
		[PERSONAL, SHARED, DELETE_ME],
	);
	await pool.query(
		`insert into membership_key
		 (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext,
		  recipient_public_key, granted_by)
		 values ('account-delete-personal-mk', 'account-delete-personal-seat', $1,
		         $2, 1, 'enc', 'cipher', 'delete-public-key', $1),
		        ('account-delete-shared-mk', 'account-delete-shared-owner', $1,
		         $3, 1, 'enc', 'cipher', 'delete-public-key', $1)`,
		[DELETE_ME, PERSONAL, SHARED],
	);
	if (otherHolder) {
		await pool.query(
			`insert into membership_key
			 (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext,
			  recipient_public_key, granted_by)
			 values ('account-delete-remaining-mk', 'account-delete-shared-member', $1,
			         $2, 1, 'enc', 'cipher', 'remaining-public-key', $1)`,
			[REMAINING, SHARED],
		);
	}
	await pool.query(
		`insert into key_grant_request
		 (id, membership_id, user_id, workspace_id, requested_version)
		 values ('account-delete-request', 'account-delete-shared-owner', $1, $2, 2)`,
		[DELETE_ME, SHARED],
	);
	await pool.query(
		`insert into user_device (id, user_id, label)
		 values ('account-delete-device', $1, 'Browser')`,
		[DELETE_ME],
	);
	const content = new TextEncoder().encode("shared encrypted bytes");
	for (const [id, workspaceId, taskId, key] of [
		[PERSONAL_ATTACHMENT, PERSONAL, PERSONAL_TASK, "personal-object"],
		[SHARED_ATTACHMENT, SHARED, SHARED_TASK, "shared-object"],
	] as const) {
		await pool.query(
			`insert into attachment
			 (id, workspace_id, parent_kind, parent_id, key_version, state,
			  filename_ciphertext, content_type_ciphertext, dek_wrapped,
			  declared_bytes, observed_bytes, ciphertext_sha256, storage_key,
			  uploaded_by, committed_at)
			 values ($1, $2, 'task', $3, 1, 'committed', $4,
			         'encrypted-type', 'wrapped-dek', $5, $5, $6, $7, $8, now())`,
			[
				id,
				workspaceId,
				taskId,
				id === SHARED_ATTACHMENT ? "private-budget.pdf" : "encrypted-name",
				content.byteLength,
				createHash("sha256").update(content).digest("hex"),
				key,
				DELETE_ME,
			],
		);
		store.objects.set(key, content);
	}
}

beforeAll(() => {
	process.env.DITERO_E2E_ENABLED = "true";
});

beforeEach(async () => {
	store.objects.clear();
	await resetAuthFixture(pool);
});

afterAll(async () => {
	await resetAuthFixture(pool);
	await pool.end();
	if (previousE2EEnabled === undefined) {
		delete process.env.DITERO_E2E_ENABLED;
	} else {
		process.env.DITERO_E2E_ENABLED = previousE2EEnabled;
	}
});

describe("account deletion", () => {
	test("requires acknowledgement before orphaning the last readable shared key", async () => {
		await seed();

		const preview = await request("/api/account/deletion-preview");
		expect(preview.status).toBe(200);
		expect(await preview.json()).toEqual({
			lastHolderWorkspaces: [{ id: SHARED, name: "Shared files" }],
			soleOwnerWorkspaces: [],
		});

		const refused = await request("/api/account/delete", DELETE_ME, {
			acknowledgeKeyLoss: false,
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({
			code: "key-loss-ack-required",
			lastHolderWorkspaces: [{ id: SHARED, name: "Shared files" }],
		});
		expect(
			await pool.query("select state from attachment where id = $1", [
				PERSONAL_ATTACHMENT,
			]),
		).toMatchObject({ rows: [{ state: "committed" }] });
	});

	test("removes private keys while preserving shared workspace files", async () => {
		await seed();

		const response = await request("/api/account/delete", DELETE_ME, {
			acknowledgeKeyLoss: true,
		});

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toEqual({ deleted: true });
		const attachments = await pool.query<{ id: string; state: string }>(
			"select id, state from attachment order by id",
		);
		expect(attachments.rows).toEqual([
			{ id: PERSONAL_ATTACHMENT, state: "deleting" },
			{ id: SHARED_ATTACHMENT, state: "committed" },
		]);
		expect(await count("user_key", "user_id", DELETE_ME)).toBe(0);
		expect(await count("membership_key", "user_id", DELETE_ME)).toBe(0);
		expect(await count("key_grant_request", "user_id", DELETE_ME)).toBe(0);
		expect(await count("user_device", "user_id", DELETE_ME)).toBe(0);
		expect(await count("membership", "user_id", DELETE_ME)).toBe(0);
		expect(await count("account", "user_id", DELETE_ME)).toBe(0);
		expect(await count("session", "user_id", DELETE_ME)).toBe(0);
		const deleted = await pool.query<{
			name: string;
			email: string;
			deleted_at: Date | null;
		}>('select name, email, deleted_at from "user" where id = $1', [DELETE_ME]);
		expect(deleted.rows[0]).toMatchObject({
			name: "Deleted user",
			email: "deleted-account@example.invalid",
			deleted_at: NOW,
		});
		const workspace = await pool.query<{
			rotation_required: boolean;
			owner_id: string;
		}>("select rotation_required, owner_id from workspace where id = $1", [
			SHARED,
		]);
		expect(workspace.rows[0]?.rotation_required).toBe(true);
		expect(workspace.rows[0]?.owner_id).toBe(REMAINING);
		expect(await count("task", "id", PERSONAL_TASK)).toBe(0);

		const download = await request(
			`/api/attachments/${SHARED_ATTACHMENT}/download`,
			REMAINING,
		);
		expect(download.status).toBe(200);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(
			store.objects.get("shared-object"),
		);

		await expect(
			pool.query(
				`insert into "user" (id, name, email, email_verified, created_at, updated_at)
				 values ('account-delete-email-reuse', 'Replacement', $1, true, now(), now())`,
				[ORIGINAL_EMAIL],
			),
		).resolves.toBeDefined();
		await expect(
			attachmentSweep(pool, store, {
				now: new Date(NOW.getTime() + 2),
				retentionMs: 1,
			}),
		).resolves.toMatchObject({ deleted: 1, failed: 0 });
		expect(store.objects.has("personal-object")).toBe(false);
		expect(await count("workspace", "id", PERSONAL)).toBe(0);
	});

	test("does not require key-loss acknowledgement when another living holder remains", async () => {
		await seed(true);

		expect(
			await (await request("/api/account/deletion-preview")).json(),
		).toEqual({ lastHolderWorkspaces: [], soleOwnerWorkspaces: [] });
		const response = await request("/api/account/delete", DELETE_ME, {
			acknowledgeKeyLoss: false,
		});
		expect(response.status, await response.clone().text()).toBe(200);
	});

	test("refuses to orphan a shared workspace with no other owner", async () => {
		await seed(true);
		await pool.query(
			"update membership set role = 'member' where user_id = $1 and workspace_id = $2",
			[REMAINING, SHARED],
		);

		expect(
			await (await request("/api/account/deletion-preview")).json(),
		).toEqual({
			lastHolderWorkspaces: [],
			soleOwnerWorkspaces: [{ id: SHARED, name: "Shared files" }],
		});
		const response = await request("/api/account/delete", DELETE_ME, {
			acknowledgeKeyLoss: true,
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			code: "ownership-transfer-required",
			soleOwnerWorkspaces: [{ id: SHARED, name: "Shared files" }],
		});
		expect(await count("membership", "user_id", DELETE_ME)).toBe(2);
	});
});

test("notification payloads contain the parent title and no attachment metadata", async () => {
	await seed(true);
	await pool.query(
		`insert into notification_channel (id, user_id, kind, config)
		 values ('account-delete-channel', $1, 'ntfy', '{}')`,
		[REMAINING],
	);

	await enqueueEvents(
		db,
		[
			{
				recipientUserId: REMAINING,
				event: {
					kind: "assign",
					taskId: SHARED_TASK,
					taskTitle: "Quarterly close",
					actorUserId: DELETE_ME,
				},
				stamp: "attachment-leak-guard",
			},
		],
		{ now: NOW, maxQueuedPerUser: 10 },
	);

	const outbox = await pool.query<{ payload: unknown }>(
		"select payload from notification_outbox where recipient_user_id = $1",
		[REMAINING],
	);
	const payload = JSON.stringify(outbox.rows[0]?.payload);
	expect(payload).toContain("Quarterly close");
	expect(payload).not.toContain("private-budget.pdf");
});
