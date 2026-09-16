import { randomUUID } from "node:crypto";
import {
	Client,
	type Pool,
	type PoolClient,
	type QueryResult,
	type QueryResultRow,
} from "pg";
import { UserContextError } from "../../db/user-context.ts";
import type {
	PortableExportV1,
	PortableRows,
} from "../../domain/portability/v1.ts";

export interface ExportOptions {
	maxRows?: number;
	maxBytes?: number;
	now?: () => Date;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export class ExportLimitError extends Error {
	constructor() {
		super("Export exceeds the configured limit");
	}
}

export class ExportInterruptedError extends Error {
	constructor(readonly code: "export-timeout" | "export-cancelled") {
		super(code);
	}
}

type RunQuery = <T extends QueryResultRow = Record<string, unknown>>(
	sql: string,
	parameters?: unknown[],
) => Promise<QueryResult<T>>;

async function cancelBackend(pool: Pool, pid: number, applicationName: string) {
	// A disconnected socket does not interrupt PostgreSQL while it waits on a
	// lock. A separate, bounded connection cancels only this export's backend.
	const control = new Client({
		...pool.options,
		connectionTimeoutMillis: 1000,
		query_timeout: 1000,
		statement_timeout: 1000,
	});
	try {
		await control.connect();
		await control.query(
			`select pg_cancel_backend(pid) from pg_stat_activity
			where pid = $1 and application_name = $2 and usename = current_user`,
			[pid, applicationName],
		);
	} catch {
		console.error("portability export cancellation failed");
	} finally {
		await control.end();
	}
}

async function withExportClient<T>(
	pool: Pool,
	options: ExportOptions,
	run: (query: RunQuery, signal: AbortSignal, check: () => void) => Promise<T>,
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
		throw new Error("Invalid export timeout");
	const deadline = performance.now() + timeoutMs;
	const controller = new AbortController();
	let client: PoolClient | undefined;
	let backendPid: number | undefined;
	let cancellation: Promise<void> | undefined;
	let queryPending = false;
	const applicationName = `portability-${randomUUID()}`;
	let released = false;
	const release = (destroy = false) => {
		if (client && !released) {
			released = true;
			client.release(destroy);
		}
	};
	const cancel = () =>
		controller.abort(new ExportInterruptedError("export-cancelled"));
	const timer = setTimeout(
		() => controller.abort(new ExportInterruptedError("export-timeout")),
		timeoutMs,
	);
	const check = () => {
		if (performance.now() >= deadline && !controller.signal.aborted)
			controller.abort(new ExportInterruptedError("export-timeout"));
		controller.signal.throwIfAborted();
	};
	let rejectAcquisition: (reason: unknown) => void = () => {};
	const interrupted = new Promise<never>((_resolve, reject) => {
		rejectAcquisition = reject;
	});
	// Install a rejection handler even when the request was already cancelled.
	void interrupted.catch(() => {});
	const onAbort = () => {
		if (queryPending && backendPid !== undefined)
			cancellation = cancelBackend(pool, backendPid, applicationName);
		else release(true);
		rejectAcquisition(controller.signal.reason);
	};
	controller.signal.addEventListener("abort", onAbort, { once: true });
	options.signal?.addEventListener("abort", cancel, { once: true });
	if (options.signal?.aborted) cancel();
	try {
		check();
		const acquired = await Promise.race([
			pool.connect().then((acquired) => {
				client = acquired;
				// Pool acquisition cannot be cancelled; return a late arrival immediately.
				if (controller.signal.aborted) release();
				return acquired;
			}),
			interrupted,
		]);
		check();
		const query: RunQuery = async (sql, parameters) => {
			check();
			queryPending = true;
			try {
				await acquired.query(
					"select set_config('statement_timeout', $1, true)",
					[`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`],
				);
				check();
				return await acquired.query(sql, parameters);
			} finally {
				queryPending = false;
			}
		};
		await acquired.query("begin isolation level repeatable read");
		const identity = await query<{ pid: number }>(
			"select pg_backend_pid() as pid, set_config('application_name', $1, true)",
			[applicationName],
		);
		backendPid = identity.rows[0]?.pid;
		return await run(query, controller.signal, check);
	} catch (error) {
		check();
		if (controller.signal.aborted) throw controller.signal.reason;
		if (client && !released) {
			try {
				await client.query("rollback");
			} catch {
				release(true);
			}
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
		controller.signal.removeEventListener("abort", onAbort);
		release(controller.signal.aborted);
		await cancellation;
	}
}

// PGLZ emits at most 273 bytes per 3-byte match. LZ4 length-extension bytes
// add at most 255 bytes each (plus a token and 2-byte offset per match).
// 256 safely bounds both, including their headers; unknown codecs fail closed.
// https://github.com/postgres/postgres/blob/REL_17_STABLE/src/common/pg_lzcompress.c
// https://github.com/lz4/lz4/blob/v1.10.0/doc/lz4_Block_format.md
const MAX_TOAST_EXPANSION = 256;
const JSON_FIELDS = new Set([
	"content",
	"filter",
	"display",
	"panels",
	"keymap",
	"pinnedViews",
	"karmaGoals",
	"vacation",
	"focus",
	"quietHours",
	"escalationDefaults",
]);

async function preflight(
	query: RunQuery,
	sql: string,
	parameters: unknown[],
	maxRows: number,
	maxBytes: number,
	fields: readonly string[],
) {
	// octet_length(text) reads the logical TOAST size without JSON escaping.
	// JSONB has no equivalent raw-size SQL probe; bound supported compression
	// before detoasting. This may conservatively refuse an otherwise fitting file.
	const rawSize = fields
		.map((field) => {
			const column = `projected."${field}"`;
			return JSON_FIELDS.has(field)
				? `coalesce(pg_column_size(${column})::bigint * case when pg_column_compression(${column}) is null then 1 when pg_column_compression(${column}) in ('pglz', 'lz4') then ${MAX_TOAST_EXPANSION} else ${Math.max(1, maxBytes + 1)} end, 0)`
				: `coalesce(octet_length(${column}::text)::bigint, 0)`;
		})
		.join(" + ");
	// A control character can become six JSON bytes (\u00XX); reserve field
	// labels and punctuation before bounding the whole projected row.
	const overhead = fields.reduce(
		(size, field) => size + Buffer.byteLength(JSON.stringify(field)) + 2,
		2,
	);
	const rawBudget = Math.max(0, Math.floor((maxBytes - overhead) / 6));
	const oversized = await query<{ oversized: boolean }>(
		`select exists (select 1 from (${sql}) projected where (${rawSize}) > $${parameters.length + 1}) as oversized`,
		[...parameters, rawBudget],
	);
	if (oversized.rows[0]?.oversized) throw new ExportLimitError();
	const result = await query<{ count: string; bytes: string }>(
		`select count(*)::text as count, coalesce(sum(octet_length(row_to_json(projected)::text)), 0)::text as bytes from (${sql}) projected`,
		parameters,
	);
	const count = Number(result.rows[0]?.count);
	const bytes = Number(result.rows[0]?.bytes) + Math.max(0, count - 1);
	if (count > maxRows || bytes > maxBytes) throw new ExportLimitError();
}

const workspaceScope = "r.workspace_id = any($1::text[])";
const visibleTasks =
	"select t.id from task t join list l on l.id = t.list_id where l.workspace_id = any($1::text[])";
const taskScope = `r.task_id in (${visibleTasks})`;
const pageScope = `((r.scope = 'personal' and r.owner_id = $2) or (r.scope = 'workspace' and ${workspaceScope}))`;

// These projections are the versioned contract. New database columns must not
// silently become exports, particularly on tables which also hold credentials.
const projections = {
	principals: ["id", "name"],
	workspaces: ["id", "name", "ownerId", "kind"],
	memberships: ["id", "userId", "workspaceId", "role"],
	folders: ["id", "workspaceId", "name", "sortKey"],
	lists: [
		"id",
		"workspaceId",
		"ownerId",
		"title",
		"kind",
		"icon",
		"folderId",
		"sortKey",
		"completedDisplay",
	],
	tasks: [
		"id",
		"listId",
		"title",
		"done",
		"notes",
		"dueAt",
		"dueAllDay",
		"priority",
		"completedAt",
		"sortKey",
		"parentId",
		"quantity",
		"unit",
		"category",
		"rrule",
		"recurrenceRelative",
		"reminderTime",
		"repeatEveryMin",
		"maxRepeats",
		"fallbackUserId",
		"urgent",
	],
	labels: ["id", "workspaceId", "name", "color"],
	taskLabels: ["id", "taskId", "labelId"],
	templates: [
		"id",
		"workspaceId",
		"kind",
		"name",
		"icon",
		"content",
		"createdBy",
	],
	assignments: ["id", "taskId", "userId"],
	comments: ["id", "taskId", "authorId", "body", "createdAt", "editedAt"],
	habitLogs: [
		"id",
		"habitId",
		"date",
		"status",
		"karmaDelta",
		"completedAt",
		"createdAt",
	],
	views: [
		"id",
		"ownerId",
		"workspaceId",
		"name",
		"icon",
		"scope",
		"filter",
		"display",
		"sortKey",
		"createdAt",
		"updatedAt",
	],
	dashboards: [
		"id",
		"ownerId",
		"workspaceId",
		"scope",
		"name",
		"icon",
		"panels",
		"sortKey",
		"createdAt",
		"updatedAt",
	],
	userPrefs: [
		"id",
		"keymap",
		"keymapProfile",
		"homeViewRef",
		"pinnedViews",
		"karmaGoals",
		"vacation",
		"focus",
		"timezone",
		"quietHours",
		"escalationDefaults",
		"locale",
		"theme",
		"e2eAutoLockMinutes",
		"createdAt",
		"updatedAt",
	],
	focusSessions: [
		"id",
		"userId",
		"taskId",
		"kind",
		"startedAt",
		"endedAt",
		"durationSec",
		"createdAt",
	],
	karma: ["userId", "points", "level", "updatedAt"],
	karmaEvents: ["id", "userId", "date", "delta", "reason", "createdAt"],
	attachments: [
		"id",
		"workspaceId",
		"parentKind",
		"parentId",
		"keyVersion",
		"declaredBytes",
		"observedBytes",
		"ciphertextSha256",
		"thumbnailDeclaredBytes",
		"thumbnailObservedBytes",
		"thumbnailCiphertextSha256",
		"uploadedBy",
		"createdAt",
		"committedAt",
	],
} as const satisfies {
	[K in keyof PortableRows]: readonly (keyof PortableRows[K])[];
};

async function* cursorRows<T extends object>(
	query: RunQuery,
	signal: AbortSignal,
	sql: string,
	parameters: unknown[],
) {
	await query(
		`declare portability_cursor no scroll cursor for ${sql}`,
		parameters,
	);
	try {
		while (true) {
			const page = await query<T>("fetch forward 256 from portability_cursor");
			for (const row of page.rows) yield row;
			if (page.rows.length < 256) break;
		}
	} finally {
		if (!signal.aborted) await query("close portability_cursor");
	}
}

export async function exportPortableJson(
	pool: Pool,
	userId: string,
	options: ExportOptions = {},
): Promise<string> {
	const maxRows = options.maxRows ?? 50_000;
	const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
	if (
		!Number.isSafeInteger(maxRows) ||
		maxRows < 0 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0
	) {
		throw new Error("Invalid export limits");
	}
	return withExportClient(pool, options, async (query, signal, check) => {
		await query("select set_config('ditero.user_id', $1, true)", [userId]);
		const live = await query(
			'select id from "user" where id = $1 and deleted_at is null for key share',
			[userId],
		);
		if (live.rowCount !== 1) throw new UserContextError();
		await preflight(
			query,
			'select workspace_id as "workspaceId" from membership where user_id = $1',
			[userId],
			maxRows,
			maxBytes,
			["workspaceId"],
		);
		const workspaceIds: string[] = [];
		for await (const row of cursorRows<{ workspaceId: string }>(
			query,
			signal,
			'select workspace_id as "workspaceId" from membership where user_id = $1 order by id for share',
			[userId],
		)) {
			workspaceIds.push(row.workspaceId);
			if (workspaceIds.length > maxRows) throw new ExportLimitError();
		}
		const data: PortableExportV1["data"] = {
			principals: [],
			workspaces: [],
			memberships: [],
			folders: [],
			lists: [],
			tasks: [],
			labels: [],
			taskLabels: [],
			templates: [],
			assignments: [],
			comments: [],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
		};
		const snapshot: PortableExportV1 = {
			format: "ditero",
			schemaVersion: 1,
			exportedAt: (options.now?.() ?? new Date()).toISOString(),
			sourceUserId: userId,
			boundaries: {
				attachmentContent: "excluded",
				encryptionKeys: "excluded",
				credentials: "excluded",
				managedAccounts: "excluded",
				restoreSupported: false,
				taskHistory: "current-state-and-habit-logs",
			},
			data,
		};
		let rows = 0;
		let bytes = Buffer.byteLength(JSON.stringify(snapshot));
		const principalIds = new Set([userId]);
		async function collect<K extends keyof PortableRows>(
			key: K,
			table: string,
			where: string,
			parameters: unknown[] = [workspaceIds, userId],
		) {
			const projection = projections[key]
				.map((field) => {
					const column = field.replace(
						/[A-Z]/g,
						(char) => `_${char.toLowerCase()}`,
					);
					let expression = `r.${column}`;
					if (key === "focusSessions" && field === "taskId")
						expression = `case when ${taskScope} then r.task_id else null end`;
					if (key === "attachments" && field.endsWith("Bytes"))
						expression += "::float8";
					return `${expression} as "${field}"`;
				})
				.join(", ");
			const order = key === "karma" ? "user_id" : "id";
			// All identifiers and expressions above are static; only values are bound.
			const selection = `select ${projection} from "${table}" r where ${where}`;
			// Measure inside the snapshot before any page materializes text values
			// in the application. PostgreSQL JSON formatting is conservative here.
			await preflight(
				query,
				selection,
				parameters,
				maxRows - rows,
				maxBytes - bytes,
				projections[key],
			);
			const sql = `${selection} order by r.${order}`;
			for await (const row of cursorRows<Record<string, unknown>>(
				query,
				signal,
				sql,
				parameters,
			)) {
				check();
				const serialized = JSON.stringify(row);
				rows++;
				bytes += Buffer.byteLength(serialized) + (data[key].length ? 1 : 0);
				if (rows > maxRows || bytes > maxBytes) throw new ExportLimitError();
				data[key].push(JSON.parse(serialized) as PortableRows[K]);
				for (const field of [
					"ownerId",
					"userId",
					"createdBy",
					"authorId",
					"fallbackUserId",
					"uploadedBy",
				]) {
					if (typeof row[field] === "string") principalIds.add(row[field]);
				}
			}
		}
		await collect("workspaces", "workspace", "r.id = any($1::text[])", [
			workspaceIds,
		]);
		await collect("memberships", "membership", workspaceScope, [workspaceIds]);
		await collect("folders", "folder", workspaceScope, [workspaceIds]);
		await collect("lists", "list", workspaceScope, [workspaceIds]);
		await collect("tasks", "task", `r.id in (${visibleTasks})`, [workspaceIds]);
		await collect("labels", "label", workspaceScope, [workspaceIds]);
		await collect(
			"taskLabels",
			"task_label",
			`${taskScope} and r.label_id in (select id from label where workspace_id = any($1::text[]))`,
			[workspaceIds],
		);
		await collect("templates", "template", workspaceScope, [workspaceIds]);
		await collect("assignments", "task_assignee", taskScope, [workspaceIds]);
		await collect("comments", "comment", taskScope, [workspaceIds]);
		await collect("habitLogs", "habit_log", `r.habit_id in (${visibleTasks})`, [
			workspaceIds,
		]);
		await collect("views", "view", pageScope);
		await collect("dashboards", "dashboard", pageScope);
		await collect("userPrefs", "user_pref", "r.id = $1", [userId]);
		await collect("focusSessions", "focus_session", "r.user_id = $2");
		await collect("karma", "karma", "r.user_id = $1", [userId]);
		await collect("karmaEvents", "karma_event", "r.user_id = $1", [userId]);
		await collect(
			"attachments",
			"attachment",
			`${workspaceScope} and r.state = 'committed' and r.deleted_at is null`,
			[workspaceIds],
		);
		await collect("principals", "user", "r.id = any($1::text[])", [
			[...principalIds],
		]);
		check();
		const serialized = JSON.stringify(snapshot);
		check();
		if (Buffer.byteLength(serialized) > maxBytes) throw new ExportLimitError();
		await query("commit");
		check();
		return serialized;
	});
}
