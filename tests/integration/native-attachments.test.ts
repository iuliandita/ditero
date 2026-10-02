import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { nativeAttachmentRoutes } from "../../src/server/native-auth/attachment-routes.ts";
import {
	type Sessions,
	s256Challenge,
} from "../../src/server/native-auth/contracts.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import { FsBlobStore } from "../../src/server/storage/fs-store.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const role = `native_attachments_${suffix}`;
const password = randomBytes(32).toString("hex");
const roleURL = new URL(databaseURL);
roleURL.username = role;
roleURL.password = password;
const restricted = new Pool({ connectionString: roleURL.toString(), max: 6 });
const users: string[] = [];
const grants: string[] = [];
const verifier = "c".repeat(43);
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
	.origin;
let roleCreated = false;
let sessions: Sessions;
let store: NativeGrantStore;
let routes: ReturnType<typeof nativeAttachmentRoutes>;
let blobRoot: string;
let workspace: string;
let allowRequests = true;
const previousE2E = process.env.DITERO_E2E_ENABLED;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on "user", session, user_device, native_auth_grant, native_session_link, workspace, membership, workspace_access_scope, workspace_key, membership_key, list, task, comment, attachment to "${role}"`,
	);
	const privilege = await restricted.query<{
		rolsuper: boolean;
		rolbypassrls: boolean;
	}>(
		"select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
	);
	expect(privilege.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
	const adapter = (await auth.$context).internalAdapter;
	sessions = {
		createSession: (userId) => adapter.createSession(userId, false),
		deleteSession: (token) => adapter.deleteSession(token),
	};
	store = new NativeGrantStore(restricted, sessions);
	blobRoot = await mkdtemp(join(tmpdir(), "ditero-native-attachments-"));
	routes = nativeAttachmentRoutes({
		pool: restricted,
		store: new FsBlobStore(blobRoot),
		options: { quotaBytes: 1024 },
		rateLimit: async () => allowRequests,
	});
	process.env.DITERO_E2E_ENABLED = "true";
});

afterAll(async () => {
	if (previousE2E === undefined) delete process.env.DITERO_E2E_ENABLED;
	else process.env.DITERO_E2E_ENABLED = previousE2E;
	const errors: unknown[] = [];
	for (const cleanup of [
		async () => {
			// Links, sessions and devices go before the user; the projection row
			// follows its membership, which goes before its workspace.
			await admin.query(
				"delete from native_session_link where user_id = any($1::text[])",
				[users],
			);
			await admin.query("delete from session where user_id = any($1::text[])", [
				users,
			]);
			await admin.query(
				"delete from user_device where user_id = any($1::text[])",
				[users],
			);
			if (workspace) {
				for (const table of ["attachment", "membership_key", "workspace_key"])
					await admin.query(`delete from ${table} where workspace_id = $1`, [
						workspace,
					]);
				await admin.query(
					"delete from task where list_id in (select id from list where workspace_id = $1)",
					[workspace],
				);
				await admin.query("delete from list where workspace_id = $1", [
					workspace,
				]);
			}
			await admin.query(
				"delete from membership where user_id = any($1::text[]) or workspace_id in (select id from workspace where owner_id = any($1::text[]))",
				[users],
			);
			await admin.query(
				"delete from workspace where owner_id = any($1::text[])",
				[users],
			);
			await admin.query(
				"delete from native_auth_grant where id = any($1::text[])",
				[grants],
			);
			await admin.query('delete from "user" where id = any($1::text[])', [
				users,
			]);
		},
		async () => {
			await restricted.end();
		},
		async () => {
			if (roleCreated) {
				await admin.query(`drop owned by "${role}"`);
				await admin.query(`drop role "${role}"`);
			}
		},
		async () => {
			if (blobRoot) await rm(blobRoot, { recursive: true, force: true });
			await admin.end();
		},
	]) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Native encryption cleanup failed");
});

// A real user, browser session, and native session minted through the actual
// grant flow, so authentication is never faked.
async function actor(label: string) {
	const id = `native-e2e-${randomUUID()}`;
	users.push(id);
	const name = `${label} ${suffix}`;
	const email = `${id}@example.test`;
	await admin.query(
		'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
		[id, name, email],
	);
	const browser = await sessions.createSession(id);
	const grant = await store.create(
		s256Challenge(verifier),
		"Encryption test device",
	);
	grants.push(grant.grantId);
	expect(await store.approve(grant.grantId, id, browser.id)).toBe("approved");
	const native = await store.exchange(grant.grantId, verifier);
	if (native.kind !== "ok") throw new Error(`Exchange failed: ${native.kind}`);
	return {
		id,
		name,
		email,
		browser,
		token: native.token,
		sessionId: native.sessionId,
		deviceId: native.deviceId,
	};
}

function request(
	path: string,
	token?: string,
	body?: unknown,
	extra: Record<string, string> = {},
) {
	const headers = {
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...extra,
	};
	return routes.handle(
		new Request(`${origin}/api/native/attachments/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
function check(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	return response;
}

test("real native grants stream private ciphertext and refuse browser credentials and revoked devices", async () => {
	const alice = await actor("Alice");
	const bob = await actor("Bob");
	workspace = `attachments-${suffix}`;
	const list = `list-${suffix}`;
	const task = `task-${suffix}`;
	const membership = `membership-${suffix}`;
	await admin.query(
		"insert into workspace (id, name, owner_id, kind) values ($1, 'Private attachments', $2, 'personal')",
		[workspace, alice.id],
	);
	await admin.query(
		"insert into membership (id, user_id, workspace_id, role) values ($1, $2, $3, 'owner')",
		[membership, alice.id, workspace],
	);
	await admin.query(
		"insert into list (id, workspace_id, owner_id, title, kind, sort_key) values ($1, $2, $3, 'Files', 'tasks', 'a')",
		[list, workspace, alice.id],
	);
	await admin.query(
		"insert into task (id, list_id, title, sort_key) values ($1, $2, 'File', 'a')",
		[task, list],
	);
	await admin.query(
		"insert into workspace_key (id, workspace_id, version, commitment, minted_by) values ($1, $2, 1, 'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', $3)",
		[`key-${suffix}`, workspace, alice.id],
	);
	await admin.query(
		"insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by) values ($1, $2, $3, $4, 1, 'enc', 'cipher', 'pk', $3)",
		[`mk-${suffix}`, membership, alice.id, workspace],
	);
	expect(await check(await request("config", alice.token), 200).json()).toEqual(
		{ maxFileBytes: 1024 },
	);
	const browserHeaders: Record<string, string>[] = [
		{ cookie: `better-auth.session_token=${alice.browser.token}` },
		{ origin },
		{ origin, cookie: "browser" },
	];
	for (const headers of browserHeaders) {
		expect(
			await check(
				await request("config", alice.token, undefined, headers),
				400,
			).json(),
		).toEqual({ code: "credentials-not-allowed" });
	}
	expect(await check(await request("config"), 401).json()).toEqual({
		code: "unauthorized",
	});
	allowRequests = false;
	check(await request("config", alice.token), 429);
	allowRequests = true;
	const id = `attachment-${suffix}`;
	const bytes = new Uint8Array([0, 255, 13, 42, 128, 1]);
	const metadata = {
		id,
		workspaceId: workspace,
		parentKind: "task",
		parentId: task,
		keyVersion: 1,
		filenameCiphertext: "opaque-name",
		contentTypeCiphertext: "opaque-type",
		dekWrapped: "opaque-wrap",
		declaredBytes: bytes.byteLength,
	};
	check(
		await request("reserve", alice.token, {
			...metadata,
			arbitraryPath: "/etc/passwd",
		}),
		400,
	);
	const malformed = (headers: Record<string, string>, body: string) =>
		routes.handle(
			new Request(`${origin}/api/native/attachments/reserve`, {
				method: "POST",
				headers: { authorization: `Bearer ${alice.token}`, ...headers },
				body,
			}),
		);
	expect(
		await check(
			await malformed(
				{ "content-type": "application/json", cookie: "browser" },
				"{",
			),
			400,
		).json(),
	).toEqual({ code: "credentials-not-allowed" });
	check(await malformed({ "content-type": "application/json" }, "{"), 400);
	check(
		await malformed({ "content-type": "text/plain" }, JSON.stringify(metadata)),
		415,
	);
	check(
		await malformed(
			{ "content-type": "application/json" },
			" ".repeat(2 * 1024 * 1024 + 1),
		),
		413,
	);

	check(await request("reserve", bob.token, metadata), 403);
	const reservation = await check(
		await request("reserve", alice.token, metadata),
		200,
	).json();
	expect(reservation.uploadUrl).toBe(`/api/attachments/${id}/upload`);
	const upload = (token: string) =>
		routes.handle(
			new Request(`${origin}/api/native/attachments/${id}/upload`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/octet-stream",
					"content-length": String(bytes.byteLength),
				},
				body: bytes,
			}),
		);
	check(await upload(bob.token), 404);
	check(await upload(alice.token), 200);
	check(await request("finalize", alice.token, { id }), 200);
	check(await request(`${id}/download`, bob.token), 403);
	const download = check(await request(`${id}/download`, alice.token), 200);
	expect(download.headers.get("content-type")).toBe("application/octet-stream");
	expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
	await admin.query("update user_device set revoked_at = now() where id = $1", [
		alice.deviceId,
	]);
	expect(
		await check(await request(`${id}/download`, alice.token), 401).json(),
	).toEqual({ code: "unauthorized" });
});
