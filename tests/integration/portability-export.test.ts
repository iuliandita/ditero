import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Client, Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import type { ExportOptions } from "../../src/server/portability/export.ts";
import { portabilityRoutes } from "../../src/server/portability/routes.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const now = new Date("2026-09-16T10:00:00.000Z");
const guards = makeGuards(["http://localhost"], async (headers) => {
	const id = headers.get("x-test-user");
	return id ? ({ user: { id } } as Session) : null;
});

const expectedFields = {
	principals: "id name",
	workspaces: "id name ownerId kind",
	memberships: "id userId workspaceId role",
	folders: "id workspaceId name sortKey",
	lists:
		"id workspaceId ownerId title kind icon folderId sortKey completedDisplay",
	tasks:
		"id listId title done notes dueAt dueAllDay priority completedAt sortKey parentId quantity unit category rrule recurrenceRelative reminderTime repeatEveryMin maxRepeats fallbackUserId urgent",
	labels: "id workspaceId name color",
	taskLabels: "id taskId labelId",
	templates: "id workspaceId kind name icon content createdBy",
	assignments: "id taskId userId",
	comments: "id taskId authorId body createdAt editedAt",
	habitLogs: "id habitId date status karmaDelta completedAt createdAt",
	views:
		"id ownerId workspaceId name icon scope filter display sortKey createdAt updatedAt",
	dashboards:
		"id ownerId workspaceId scope name icon panels sortKey createdAt updatedAt",
	userPrefs:
		"id keymap keymapProfile homeViewRef pinnedViews karmaGoals vacation focus timezone quietHours escalationDefaults locale theme e2eAutoLockMinutes createdAt updatedAt",
	focusSessions:
		"id userId taskId kind startedAt endedAt durationSec createdAt",
	karma: "userId points level updatedAt",
	karmaEvents: "id userId date delta reason createdAt",
	attachments:
		"id workspaceId parentKind parentId keyVersion declaredBytes observedBytes ciphertextSha256 thumbnailDeclaredBytes thumbnailObservedBytes thumbnailCiphertextSha256 uploadedBy createdAt committedAt",
};

function request(options: ExportOptions = {}, user = "alice", origin?: string) {
	const app = new Elysia().use(
		portabilityRoutes(pool, guards, { now: () => now, ...options }),
	);
	return app.handle(
		new Request("http://localhost/api/portability/export", {
			headers: {
				...(user ? { "x-test-user": user } : {}),
				...(origin ? { origin } : {}),
			},
		}),
	);
}

async function exported() {
	const response = await request();
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as PortableExportV1;
}

async function waitingExports() {
	const result = await pool.query<{
		count: string;
	}>(`select count(*)::text as count from pg_stat_activity
		where datname = current_database() and wait_event_type = 'Lock' and query like '%from "list" r%'`);
	return Number(result.rows[0]?.count);
}

function exportRequest(user: string, signal?: AbortSignal) {
	return new Request("http://localhost/api/portability/export", {
		headers: { "x-test-user": user },
		signal,
	});
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	await db.insert(tables.user).values(
		["alice", "bob", "outsider"].map((id) => ({
			id,
			name: id,
			email: `${id}@example.test`,
			createdAt: now,
			updatedAt: now,
		})),
	);
	await db.insert(tables.workspace).values([
		{ id: "shared", name: "Shared", ownerId: "bob", rotationRequired: true },
		{ id: "private", name: "Private", ownerId: "alice", kind: "personal" },
		{ id: "foreign", name: "FOREIGN", ownerId: "outsider" },
	]);
	await db.insert(tables.membership).values([
		{ id: "z-shared-bob", userId: "bob", workspaceId: "shared", role: "owner" },
		{
			id: "b-shared-alice",
			userId: "alice",
			workspaceId: "shared",
			role: "viewer",
		},
		{ id: "a-private", userId: "alice", workspaceId: "private", role: "owner" },
		{
			id: "foreign-member",
			userId: "outsider",
			workspaceId: "foreign",
			role: "owner",
		},
	]);
	await db.insert(tables.folder).values({
		id: "folder",
		workspaceId: "shared",
		name: "Folder",
		sortKey: "a",
	});
	await db.insert(tables.list).values(
		["shared", "private", "foreign"].map((id) => ({
			id: `${id}-list`,
			workspaceId: id,
			ownerId: id === "foreign" ? "outsider" : "alice",
			title: id,
			sortKey: "a",
			folderId: id === "shared" ? "folder" : null,
		})),
	);
	await db.insert(tables.task).values(
		["shared", "private", "foreign"].map((id) => ({
			id: `${id}-task`,
			listId: `${id}-list`,
			title: id,
			sortKey: "a",
			dueAt: now,
			notes: "notes",
			fallbackUserId: id === "shared" ? "bob" : null,
		})),
	);
	await db.insert(tables.label).values({
		id: "label",
		workspaceId: "shared",
		name: "Label",
		color: "red",
	});
	await db
		.insert(tables.taskLabel)
		.values({ id: "task-label", taskId: "shared-task", labelId: "label" });
	await db
		.insert(tables.taskAssignee)
		.values({ id: "assignment", taskId: "shared-task", userId: "bob" });
	await db.insert(tables.comment).values({
		id: "comment",
		taskId: "shared-task",
		authorId: "bob",
		body: "Comment",
		createdAt: now,
	});
	await db.insert(tables.habitLog).values({
		id: "habit-log",
		habitId: "shared-task",
		date: "2026-09-16",
		status: "done",
		completedAt: now,
		karmaDelta: 3,
	});
	await db.insert(tables.template).values({
		id: "template",
		workspaceId: "shared",
		kind: "task",
		name: "Template",
		content: { kind: "task", task: { title: "Template task" } },
		createdBy: "bob",
	});
	for (const [id, ownerId, scope, workspaceId] of [
		["own", "alice", "personal", null],
		["other-personal", "bob", "personal", null],
		["workspace", "bob", "workspace", "shared"],
		["foreign", "outsider", "workspace", "foreign"],
	] as const) {
		await db.insert(tables.view).values({
			id,
			ownerId,
			scope,
			workspaceId,
			name: id,
			filter: { op: "and", conditions: [] },
			display: {
				layout: "list",
				groupBy: "none",
				sort: { field: "sortKey", dir: "asc" },
				workspaceScope: { mode: "all" },
			},
			sortKey: "a",
		});
		await db.insert(tables.dashboard).values({
			id,
			ownerId,
			scope,
			workspaceId,
			name: id,
			panels: [],
			sortKey: "a",
		});
	}
	await db.insert(tables.userPref).values([
		{ id: "alice", locale: "ro" },
		{ id: "bob", locale: "de" },
	]);
	await db.insert(tables.focusSession).values([
		{
			id: "focus-visible",
			userId: "alice",
			taskId: "shared-task",
			kind: "work",
			startedAt: now,
			endedAt: now,
			durationSec: 10,
		},
		{
			id: "focus-hidden",
			userId: "alice",
			taskId: "foreign-task",
			kind: "work",
			startedAt: now,
			endedAt: now,
			durationSec: 10,
		},
		{
			id: "focus-other",
			userId: "bob",
			kind: "work",
			startedAt: now,
			endedAt: now,
			durationSec: 10,
		},
	]);
	await db.insert(tables.karma).values([
		{ userId: "alice", points: 12 },
		{ userId: "bob", points: 99 },
	]);
	await db.insert(tables.karmaEvent).values(
		["alice", "bob"].map((userId) => ({
			id: `karma-${userId}`,
			userId,
			date: "2026-09-16",
			delta: 1,
			reason: "task",
		})),
	);
	await db.insert(tables.attachment).values(
		[
			{ id: "committed", state: "committed" as const },
			{ id: "pending", state: "reserved" as const },
			{ id: "deleted", state: "committed" as const, deletedAt: now },
		].map((row) => ({
			...row,
			workspaceId: "shared",
			parentKind: "task" as const,
			parentId: "shared-task",
			keyVersion: 1,
			filenameCiphertext: "SECRET-NAME",
			contentTypeCiphertext: "SECRET-TYPE",
			dekWrapped: "SECRET-DEK",
			declaredBytes: 42,
			observedBytes: 42,
			storageKey: `SECRET-STORAGE-${row.id}`,
			uploadedBy: "bob",
			committedAt: now,
		})),
	);
	await db.insert(tables.session).values({
		id: "session",
		userId: "alice",
		token: "SECRET-SESSION",
		expiresAt: now,
		updatedAt: now,
	});
	await db.insert(tables.account).values({
		id: "account",
		userId: "alice",
		accountId: "alice",
		providerId: "credential",
		password: "SECRET-PASSWORD",
		updatedAt: now,
	});
	await db.insert(tables.userSecret).values({
		id: "secret",
		userId: "alice",
		kind: "test",
		ciphertext: "SECRET-CIPHERTEXT",
		keyFingerprint: "SECRET-FINGERPRINT",
	});
	await db.insert(tables.userKey).values({
		id: "key",
		userId: "alice",
		publicKey: "SECRET-PUBLIC-KEY",
		state: "ready",
	});
	await db.insert(tables.workspaceKey).values({
		id: "workspace-key",
		workspaceId: "shared",
		version: 1,
		commitment: "SECRET-COMMITMENT",
		mintedBy: "bob",
	});
	await db.insert(tables.invite).values({
		id: "invite",
		workspaceId: "shared",
		token: "SECRET-INVITE",
		createdBy: "bob",
	});
	await db.insert(tables.notificationChannel).values({
		id: "channel",
		userId: "alice",
		kind: "ntfy",
		config: "SECRET-CHANNEL",
	});
	await db.insert(tables.folder).values({
		id: "FOREIGN-ROW-folder",
		workspaceId: "foreign",
		name: "Foreign",
		sortKey: "a",
	});
	await db.insert(tables.label).values({
		id: "FOREIGN-ROW-label",
		workspaceId: "foreign",
		name: "Foreign",
	});
	await db.insert(tables.taskLabel).values({
		id: "FOREIGN-ROW-task-label",
		taskId: "foreign-task",
		labelId: "FOREIGN-ROW-label",
	});
	await db.insert(tables.template).values({
		id: "FOREIGN-ROW-template",
		workspaceId: "foreign",
		kind: "task",
		name: "Foreign",
		content: { kind: "task", task: { title: "Foreign" } },
		createdBy: "outsider",
	});
	await db.insert(tables.taskAssignee).values({
		id: "FOREIGN-ROW-assignment",
		taskId: "foreign-task",
		userId: "outsider",
	});
	await db.insert(tables.comment).values({
		id: "FOREIGN-ROW-comment",
		taskId: "foreign-task",
		authorId: "outsider",
		body: "Foreign",
	});
	await db.insert(tables.habitLog).values({
		id: "FOREIGN-ROW-habit-log",
		habitId: "foreign-task",
		date: "2026-09-16",
		status: "done",
	});
	await db.insert(tables.attachment).values({
		id: "FOREIGN-ROW-attachment",
		workspaceId: "foreign",
		parentKind: "task",
		parentId: "foreign-task",
		keyVersion: 1,
		state: "committed",
		filenameCiphertext: "SECRET-FOREIGN-NAME",
		contentTypeCiphertext: "SECRET-FOREIGN-TYPE",
		dekWrapped: "SECRET-FOREIGN-DEK",
		declaredBytes: 42,
		observedBytes: 42,
		storageKey: "SECRET-FOREIGN-STORAGE",
		uploadedBy: "outsider",
		committedAt: now,
	});
	await db.insert(tables.managedAccount).values({
		id: "SECRET-MANAGED",
		userId: "outsider",
		guardianId: "alice",
		restricted: true,
	});
});

afterAll(async () => {
	await resetAuthFixture(pool);
	await pool.end();
});

describe("portable export", () => {
	test("bounds compressed JSON before serialization while accepting ordinary compressed templates", async () => {
		const observed = new Pool({ connectionString: databaseURL, max: 1 });
		const client = await observed.connect();
		const queries = vi.spyOn(client, "query");
		client.release();
		try {
			for (const codec of ["pglz", "lz4"] as const) {
				await pool.query(
					`alter table template alter column content set compression ${codec}`,
				);
				await pool.query(
					"update template set content = jsonb_build_object('kind', 'task', 'task', jsonb_build_object('title', 'Template', 'notes', repeat('x', 40 * 1024 * 1024))) where id = 'template'",
				);
				const compression = await pool.query<{ codec: string }>(
					"select pg_column_compression(content) as codec from template where id = 'template'",
				);
				expect(compression.rows[0]?.codec).toBe(codec);
				queries.mockClear();
				const app = new Elysia().use(portabilityRoutes(observed, guards));
				const refused = await app.handle(exportRequest("alice"));
				expect(refused.status).toBe(413);
				const statements = queries.mock.calls
					.map((args) => args[0])
					.filter((sql): sql is string => typeof sql === "string");
				expect(
					statements.some(
						(sql) =>
							sql.includes("pg_column_compression") &&
							sql.includes('from "template" r'),
					),
				).toBe(true);
				expect(
					statements.some(
						(sql) =>
							sql.includes("row_to_json(projected)") &&
							sql.includes('from "template" r'),
					),
				).toBe(false);
				await pool.query(
					"update template set content = jsonb_build_object('kind', 'task', 'task', jsonb_build_object('title', 'Template', 'notes', repeat('x', 20000))) where id = 'template'",
				);
				const smallCompression = await pool.query<{ codec: string }>(
					"select pg_column_compression(content) as codec from template where id = 'template'",
				);
				expect(smallCompression.rows[0]?.codec).toBe(codec);
				expect((await app.handle(exportRequest("alice"))).status).toBe(200);
			}
		} finally {
			queries.mockRestore();
			await observed.end();
			await pool.query(
				"alter table template alter column content set compression default",
			);
		}
	}, 15000);

	test("keeps admission occupied until the SQL deadline when cancellation connection capacity is exhausted", async () => {
		const blocker = await pool.connect();
		const observed = new Pool({ connectionString: databaseURL, max: 1 });
		const warm = await observed.connect();
		warm.release();
		const controller = new AbortController();
		const app = new Elysia().use(
			portabilityRoutes(observed, guards, { timeoutMs: 1500 }),
		);
		let pending: Promise<Response> | undefined;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		let connect: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await blocker.query("begin");
			await blocker.query("lock table list in access exclusive mode");
			pending = app.handle(exportRequest("alice", controller.signal));
			await expect.poll(waitingExports).toBe(1);
			connect = vi
				.spyOn(Client.prototype, "connect")
				.mockImplementationOnce(async () => {
					throw Object.assign(
						new Error("remaining connection slots reserved"),
						{ code: "53300" },
					);
				});
			controller.abort();
			await expect.poll(() => errors.mock.calls.length).toBe(1);
			expect(errors).toHaveBeenCalledWith(
				"portability export cancellation failed",
			);
			expect((await app.handle(exportRequest("alice"))).status).toBe(429);
			const response = await pending;
			expect(response.status).toBe(408);
			await expect.poll(waitingExports).toBe(0);
			await blocker.query("set local lock_timeout = '500ms'");
			await blocker.query("delete from membership where id = 'b-shared-alice'");
		} finally {
			controller.abort();
			connect?.mockRestore();
			errors.mockRestore();
			await blocker.query("rollback");
			await pending;
			blocker.release();
			await observed.end();
		}
	});

	test("refuses oversized projected text before fetching its value into the application", async () => {
		await pool.query(
			"update task set notes = repeat('x', 33 * 1024 * 1024) where id = 'shared-task'",
		);
		const observed = new Pool({ connectionString: databaseURL, max: 1 });
		const client = await observed.connect();
		const queries = vi.spyOn(client, "query");
		client.release();
		try {
			const app = new Elysia().use(portabilityRoutes(observed, guards));
			const response = await app.handle(exportRequest("alice"));
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({ code: "export-limit-exceeded" });
			const statements = queries.mock.calls
				.map((args) => args[0])
				.filter((sql): sql is string => typeof sql === "string");
			expect(
				statements.some(
					(sql) =>
						sql.includes("row_to_json(projected)") &&
						sql.includes('from "task" r'),
				),
			).toBe(false);
			expect(
				statements.some(
					(sql) =>
						sql.startsWith("declare portability_cursor") &&
						sql.includes('from "task" r'),
				),
			).toBe(false);
		} finally {
			queries.mockRestore();
			await observed.end();
		}
	});
	test("times out blocked SQL and releases its transaction locks", async () => {
		const blocker = await pool.connect();
		let pending: Promise<Response> | undefined;
		try {
			await blocker.query("begin");
			await blocker.query("lock table list in access exclusive mode");
			pending = request({ timeoutMs: 1000 });
			await expect.poll(waitingExports, { timeout: 900, interval: 10 }).toBe(1);
			const response = await pending;
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ code: "export-timeout" });
			expect(response.headers.get("content-disposition")).toBeNull();
			await expect.poll(waitingExports).toBe(0);
			await blocker.query("set local lock_timeout = '1s'");
			await blocker.query("delete from membership where id = 'b-shared-alice'");
		} finally {
			await blocker.query("rollback");
			await pending;
			blocker.release();
		}
	});

	test("cancels blocked requests and limits exports to two users and one per user", async () => {
		const blocker = await pool.connect();
		const first = new AbortController();
		const second = new AbortController();
		const app = new Elysia().use(portabilityRoutes(pool, guards));
		const pending: Promise<Response>[] = [];
		try {
			await blocker.query("begin");
			await blocker.query("lock table list in access exclusive mode");
			pending.push(app.handle(exportRequest("alice", first.signal)));
			await expect.poll(waitingExports).toBe(1);
			const duplicate = await app.handle(exportRequest("alice"));
			expect(duplicate.status).toBe(429);
			expect(duplicate.headers.get("retry-after")).toBe("5");
			expect(await duplicate.json()).toEqual({ code: "export-busy" });
			pending.push(app.handle(exportRequest("bob", second.signal)));
			await expect.poll(waitingExports).toBe(2);
			expect((await app.handle(exportRequest("outsider"))).status).toBe(429);
			first.abort();
			second.abort();
			for (const response of await Promise.all(pending)) {
				expect(response.status).toBe(408);
				expect(await response.json()).toEqual({ code: "export-cancelled" });
			}
			await expect.poll(waitingExports).toBe(0);
			await blocker.query("rollback");
			expect((await app.handle(exportRequest("alice"))).status).toBe(200);
		} finally {
			first.abort();
			second.abort();
			await blocker.query("rollback");
			await Promise.all(pending);
			blocker.release();
		}
	});

	test("bounds pool acquisition and returns late clients after timeout or cancellation", async () => {
		for (const cancel of [false, true]) {
			const limited = new Pool({ connectionString: databaseURL, max: 1 });
			const held = await limited.connect();
			let released = false;
			const controller = new AbortController();
			try {
				const app = new Elysia().use(
					portabilityRoutes(limited, guards, {
						timeoutMs: cancel ? 5000 : 300,
					}),
				);
				const pending = app.handle(exportRequest("alice", controller.signal));
				await expect.poll(() => limited.waitingCount, { interval: 10 }).toBe(1);
				if (cancel) controller.abort();
				const response = await pending;
				expect(response.status).toBe(cancel ? 408 : 503);
				expect(await response.json()).toEqual({
					code: cancel ? "export-cancelled" : "export-timeout",
				});
				held.release();
				released = true;
				await expect.poll(() => limited.idleCount).toBe(1);
				expect(limited.waitingCount).toBe(0);
				expect((await app.handle(exportRequest("alice"))).status).toBe(200);
			} finally {
				controller.abort();
				if (!released) held.release();
				await limited.end();
			}
		}
	});

	test("exports a stable, scoped v1 attachment without security material", async () => {
		const response = await request();
		expect(response.status, await response.clone().text()).toBe(200);
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="ditero-export-v1.json"',
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = await response.text();
		expect(body).not.toContain("SECRET-");
		expect(body).not.toContain("@example.test");
		expect(body).not.toContain("rotationRequired");
		expect(body).not.toContain("foreign-task");
		expect(body).not.toContain("FOREIGN-ROW-");
		const result = JSON.parse(body) as PortableExportV1;
		expect(result).toMatchObject({
			format: "ditero",
			schemaVersion: 1,
			exportedAt: now.toISOString(),
			sourceUserId: "alice",
			boundaries: {
				attachmentContent: "excluded",
				encryptionKeys: "excluded",
				credentials: "excluded",
				managedAccounts: "excluded",
				restoreSupported: false,
				taskHistory: "current-state-and-habit-logs",
			},
		});
		for (const key of Object.keys(
			expectedFields,
		) as (keyof typeof expectedFields)[]) {
			expect(result.data[key].length, key).toBeGreaterThan(0);
			for (const row of result.data[key])
				expect(Object.keys(row).sort(), key).toEqual(
					expectedFields[key].split(" ").sort(),
				);
		}
		expect(result.data.principals).toEqual([
			{ id: "alice", name: "alice" },
			{ id: "bob", name: "bob" },
		]);
		expect(result.data.workspaces.map((row) => row.id)).toEqual([
			"private",
			"shared",
		]);
		expect(result.data.memberships.map((row) => row.id)).toEqual([
			"a-private",
			"b-shared-alice",
			"z-shared-bob",
		]);
		expect(result.data.tasks.map((row) => row.id)).toEqual([
			"private-task",
			"shared-task",
		]);
		expect(result.data.tasks[0]).toMatchObject({
			dueAt: now.toISOString(),
			completedAt: null,
			notes: "notes",
		});
		expect(result.data.views.map((row) => row.id)).toEqual([
			"own",
			"workspace",
		]);
		expect(result.data.dashboards.map((row) => row.id)).toEqual([
			"own",
			"workspace",
		]);
		expect(result.data.userPrefs.map((row) => row.id)).toEqual(["alice"]);
		expect(result.data.focusSessions).toMatchObject([
			{ id: "focus-hidden", taskId: null },
			{ id: "focus-visible", taskId: "shared-task" },
		]);
		expect(result.data.karma).toMatchObject([{ userId: "alice", points: 12 }]);
		expect(result.data.karmaEvents.map((row) => row.id)).toEqual([
			"karma-alice",
		]);
		expect(result.data.attachments).toHaveLength(1);
		expect(result.data.attachments[0]).toMatchObject({
			id: "committed",
			declaredBytes: 42,
			observedBytes: 42,
			keyVersion: 1,
			committedAt: now.toISOString(),
		});
		for (const key of [
			"folders",
			"lists",
			"labels",
			"taskLabels",
			"templates",
			"assignments",
			"comments",
			"habitLogs",
		] as const)
			expect(result.data[key].length).toBeGreaterThan(0);
		expect(Object.keys(result.data).sort()).toEqual(
			[
				"principals",
				"workspaces",
				"memberships",
				"folders",
				"lists",
				"tasks",
				"labels",
				"taskLabels",
				"templates",
				"assignments",
				"comments",
				"habitLogs",
				"views",
				"dashboards",
				"userPrefs",
				"focusSessions",
				"karma",
				"karmaEvents",
				"attachments",
			].sort(),
		);
		expect(await (await request()).text()).toBe(body);
	});

	test("refuses row and byte caps without emitting a partial download, and releases the transaction", async () => {
		const complete = await (await request()).text();
		for (const options of [
			{ maxRows: 3 },
			{ maxBytes: Buffer.byteLength(complete) - 1 },
		]) {
			const response = await request(options);
			expect(response.status).toBe(413);
			expect(response.headers.get("content-disposition")).toBeNull();
			expect(await response.json()).toEqual({ code: "export-limit-exceeded" });
		}
		expect(
			(await request({ maxBytes: Buffer.byteLength(complete) + 4096 })).status,
		).toBe(200);
		expect(pool.totalCount).toBe(pool.idleCount);
	});

	test("reflects membership loss and rejects a deleted caller even with a stale session", async () => {
		await pool.query("delete from membership where id = 'b-shared-alice'");
		const result = await exported();
		expect(result.data.workspaces.map((row) => row.id)).toEqual(["private"]);
		expect(result.data.tasks.map((row) => row.id)).toEqual(["private-task"]);
		expect(result.data.attachments).toEqual([]);
		expect(result.data.views.map((row) => row.id)).toEqual(["own"]);
		expect(result.data.focusSessions.every((row) => row.taskId === null)).toBe(
			true,
		);
		await pool.query('update "user" set deleted_at = now() where id = $1', [
			"alice",
		]);
		expect((await request()).status).toBe(401);
		expect((await request({}, "missing-user")).status).toBe(401);
	});

	test("requires a session and refuses an authenticated foreign origin", async () => {
		expect((await request({}, "")).status).toBe(401);
		expect((await request({}, "alice", "https://foreign.example")).status).toBe(
			403,
		);
		expect((await request({}, "alice", "http://localhost")).status).toBe(200);
	});

	test("keeps one snapshot and holds membership revocation until export finishes", async () => {
		const blocker = await pool.connect();
		const revoker = await pool.connect();
		let response: Promise<Response> | undefined;
		try {
			await blocker.query("begin");
			await blocker.query("lock table list in access exclusive mode");
			response = request();
			await expect
				.poll(
					async () => {
						const waiting = await pool.query<{ count: string }>(
							`select count(*)::text as count from pg_stat_activity
					 where datname = current_database() and wait_event_type = 'Lock'
					 and query like '%from "list" r%'`,
						);
						return Number(waiting.rows[0]?.count);
					},
					{ timeout: 5000 },
				)
				.toBe(1);
			await revoker.query("begin");
			await revoker.query("set local lock_timeout = '100ms'");
			await expect(
				revoker.query("delete from membership where id = 'b-shared-alice'"),
			).rejects.toMatchObject({ code: "55P03" });
			await revoker.query("rollback");
			await blocker.query(
				"update task set title = 'changed after snapshot' where id = 'shared-task'",
			);
			await blocker.query("commit");
			const result = await response;
			expect(result.status, await result.clone().text()).toBe(200);
			const snapshot = (await result.json()) as PortableExportV1;
			expect(
				snapshot.data.tasks.find((row) => row.id === "shared-task")?.title,
			).toBe("shared");
			await revoker.query("delete from membership where id = 'b-shared-alice'");
		} finally {
			await blocker.query("rollback");
			await revoker.query("rollback");
			await response;
			blocker.release();
			revoker.release();
		}
	});
});
