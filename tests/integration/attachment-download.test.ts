import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { attachmentRoutes } from "../../src/server/attachments/routes.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import {
	BlobNotFoundError,
	type BlobStore,
} from "../../src/server/storage/blob-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

class MemoryBlobStore implements BlobStore {
	readonly objects = new Map<string, Uint8Array>();

	async put(key: string, body: AsyncIterable<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		let length = 0;
		for await (const chunk of body) {
			chunks.push(chunk);
			length += chunk.byteLength;
		}
		const value = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			value.set(chunk, offset);
			offset += chunk.byteLength;
		}
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

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key);
	}
}

const pool = new Pool({ connectionString: databaseURL });
const store = new MemoryBlobStore();
const WORKSPACE = "download-w";
const TASK = "download-task";
const CIPHERTEXT = new TextEncoder().encode("encrypted attachment bytes");

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

const app = new Elysia().use(attachmentRoutes(pool, guards, store));

async function availablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("failed to allocate a server port");
	}
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

async function waitForServer(
	child: ChildProcessWithoutNullStreams,
	url: string,
	logs: string[],
): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`attachment server exited early: ${logs.join("")}`);
		}
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// Boot is still in progress.
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`attachment server did not become healthy: ${logs.join("")}`);
}

async function stopServer(
	child: ChildProcessWithoutNullStreams,
): Promise<void> {
	if (child.exitCode !== null) return;
	const exit = once(child, "exit");
	child.kill("SIGTERM");
	const stopped = await Promise.race([
		exit.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
	]);
	if (!stopped && child.exitCode === null) {
		child.kill("SIGKILL");
		await exit;
	}
}

function download(id: string, userId = "download-member") {
	return app.handle(
		new Request(`http://localhost/api/attachments/${id}/download`, {
			headers: { "x-test-user": userId },
		}),
	);
}

async function seedAttachment(
	id: string,
	state: "reserved" | "uploading" | "committed" | "aborted" | "deleting",
): Promise<string> {
	const storageKey = `download-w/00/${id}`;
	await pool.query(
		`insert into attachment (id, workspace_id, parent_kind, parent_id,
		 key_version, state, filename_ciphertext, content_type_ciphertext,
		 dek_wrapped, declared_bytes, observed_bytes, ciphertext_sha256,
		 storage_key, uploaded_by, reservation_expires_at, committed_at)
		 values ($1, $2, 'task', $3, 1, $4::attachment_state, 'encrypted-name',
		 'text/html', 'wrapped-dek', $5::bigint, $5::bigint, $6, $7,
		 'download-owner',
		 case when $4::attachment_state in ('reserved', 'uploading')
		      then now() + interval '1 hour' else null end,
		 case when $4::attachment_state in ('committed', 'deleting')
		      then now() else null end)`,
		[
			id,
			WORKSPACE,
			TASK,
			state,
			CIPHERTEXT.byteLength,
			createHash("sha256").update(CIPHERTEXT).digest("hex"),
			storageKey,
		],
	);
	store.objects.set(storageKey, CIPHERTEXT);
	return storageKey;
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	store.objects.clear();
	process.env.DITERO_E2E_ENABLED = "true";
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values
		 ('download-owner', 'Owner', 'download-owner@test.invalid', true, now(), now()),
		 ('download-member', 'Member', 'download-member@test.invalid', true, now(), now()),
		 ('download-viewer', 'Viewer', 'download-viewer@test.invalid', true, now(), now()),
		 ('download-outsider', 'Outsider', 'download-outsider@test.invalid', true, now(), now())`,
	);
	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Download', 'download-owner', 'shared')`,
		[WORKSPACE],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ('download-m-owner', 'download-owner', $1, 'owner'),
		 ('download-m-member', 'download-member', $1, 'member'),
		 ('download-m-viewer', 'download-viewer', $1, 'viewer')`,
		[WORKSPACE],
	);
	await pool.query(
		`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
		 values ('download-list', $1, 'download-owner', 'Download', 'tasks', 'a')`,
		[WORKSPACE],
	);
	await pool.query(
		`insert into task (id, list_id, title, sort_key)
		 values ($1, 'download-list', 'Download task', 'a')`,
		[TASK],
	);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("attachment download", () => {
	test("is mounted by the production server composition", async () => {
		const port = await availablePort();
		const logs: string[] = [];
		const child = spawn("bun", ["run", "src/server/index.ts"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				API_PORT: String(port),
				BETTER_AUTH_URL: `http://localhost:${port}`,
				DITERO_BACKGROUND_JOBS: "0",
				DITERO_E2E_ENABLED: "true",
			},
			stdio: "pipe",
		});
		child.stdout.on("data", (chunk) => logs.push(String(chunk)));
		child.stderr.on("data", (chunk) => logs.push(String(chunk)));
		try {
			await waitForServer(child, `http://127.0.0.1:${port}/health`, logs);
			const response = await fetch(
				`http://127.0.0.1:${port}/api/attachments/unknown/download`,
			);

			// The real auth guard sees the route and rejects the absent session. An
			// unmounted route falls through Elysia as 404 before any guard can run.
			expect(response.status).toBe(401);
		} finally {
			await stopServer(child);
		}
	}, 15_000);

	test("returns the committed ciphertext byte-for-byte to a current member", async () => {
		await seedAttachment("att-download", "committed");

		const response = await download("att-download");

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(CIPHERTEXT);
	});

	test("allows a Viewer to fetch ciphertext without granting write access", async () => {
		await seedAttachment("att-viewer", "committed");

		expect((await download("att-viewer", "download-viewer")).status).toBe(200);
	});

	test("returns 403 and no blob bytes to a non-member", async () => {
		await seedAttachment("att-outsider", "committed");

		const response = await download("att-outsider", "download-outsider");

		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
	});

	test("forces hostile declared types to a download-only octet stream", async () => {
		await seedAttachment("att-headers", "committed");

		const response = await download("att-headers");

		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test.each([
		"reserved",
		"aborted",
		"deleting",
	] as const)("does not serve a %s row", async (state) => {
		await seedAttachment(`att-${state}`, state);

		const response = await download(`att-${state}`);

		expect(response.status).toBe(404);
		expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(
			CIPHERTEXT,
		);
	});

	test("rechecks membership on each download", async () => {
		await seedAttachment("att-revoked", "committed");
		expect((await download("att-revoked")).status).toBe(200);
		await pool.query("delete from membership where id = 'download-m-member'");

		const response = await download("att-revoked");

		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
	});

	test("stays hidden while end-to-end encryption is disabled", async () => {
		await seedAttachment("att-disabled", "committed");
		process.env.DITERO_E2E_ENABLED = "false";

		expect((await download("att-disabled")).status).toBe(404);
	});
});
