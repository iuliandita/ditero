import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { mustGetQuery } from "@rocicorp/zero";
import { handleQueryRequest } from "@rocicorp/zero/server";
import { Pool } from "pg";
import { z } from "zod";
import { queries as appQueries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { browserToday, shiftDay } from "../support/browser-day.ts";
import {
	openWorkspaceSwitcher,
	signUp,
	uniqueEmail,
	workspaceOption,
} from "./helpers.ts";

// M-dash dashboards e2e. Exercises the dashboard lifecycle (create from the
// sidebar, empty state, add view-ref/inline panels), live task completion from
// a panel (task.complete wiring), edit mode (drag reorder + persist, resize,
// remove), sharing (workspace-shared visible to members only, personal stays
// private, viewer read-only), the seeded streak + focus panels, keyboard/
// palette/home navigation, and the axe merge gate on every new surface.
// Conventions (signUp/uniqueEmail/testid locators/pg seeding/frozen-frame axe)
// mirror views.spec + habits.spec + sharing.spec.
test.describe.configure({ timeout: 90_000 });

const SHARED_WORKSPACE_ID = "w_shared_e2e";
const SIGNUP_TIMEOUT = 30_000;

function sidebarLists(page: Page): Locator {
	return page.getByRole("navigation", { name: "Lists" });
}

async function waitWorkspaceReady(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: /'s space/ })).toBeVisible({
		timeout: SIGNUP_TIMEOUT,
	});
}

async function createListDesktop(page: Page, name: string): Promise<void> {
	await waitWorkspaceReady(page);
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("sidebar-new-list").click();
	await page.getByTestId("new-list").fill(name);
	await page.getByTestId("new-list-submit").click();
	await expect(
		sidebarLists(page).getByRole("button", { name, exact: true }).first(),
	).toBeVisible({ timeout: 15000 });
}

async function openListDesktop(page: Page, name: string): Promise<void> {
	await sidebarLists(page)
		.getByRole("button", { name, exact: true })
		.last()
		.click();
	await expect(page.getByTestId("list")).toBeVisible();
}

async function addTask(page: Page, title: string): Promise<void> {
	await page.getByTestId("new-task").fill(title);
	await page.getByTestId("new-task-submit").click();
	await expect(
		page.getByTestId("list").getByText(title, { exact: true }),
	).toBeVisible({ timeout: 15000 });
}

// Drop focus so single-key/sequence shortcuts fire (inert inside inputs).
async function blur(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

// Radix Select: open the trigger, click the option (rendered in a body portal).
async function pickSelect(
	page: Page,
	trigger: Locator,
	option: string,
): Promise<void> {
	await trigger.click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

// New dashboard via the sidebar control; scope defaults to personal, or
// workspace-shared when a workspace name is given. Waits for the manager
// dialog teardown so its overlay can't intercept the next click.
async function createDashboard(
	page: Page,
	name: string,
	opts: { workspace?: string } = {},
): Promise<void> {
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-dashboard").click();
	await page.getByTestId("dashboard-name").fill(name);
	if (opts.workspace) {
		await pickSelect(
			page,
			page.getByLabel("Visibility", { exact: true }),
			"Workspace",
		);
		await pickSelect(
			page,
			page.getByLabel("Shared in", { exact: true }),
			opts.workspace,
		);
	}
	await page.getByTestId("dashboard-save").click();
	await expect(page.getByTestId("dashboard-surface")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("dashboard-name")).toBeHidden({
		timeout: 15000,
	});
}

async function openDashboardFromSidebar(
	page: Page,
	name: string,
): Promise<void> {
	await sidebarLists(page).getByRole("button", { name, exact: true }).click();
	await expect(page.getByTestId("dashboard-surface")).toBeVisible({
		timeout: 15000,
	});
}

// AddPanelDialog teardown wait: the closing dialog overlay can otherwise
// intercept the next grid click (same race views.spec guards on the quickadd
// sheet).
async function expectPanelDialogClosed(page: Page): Promise<void> {
	await expect(page.getByTestId("panel-save")).toBeHidden({ timeout: 15000 });
}

// Add a focus panel with an explicit title (the simplest panel type: no
// source/habit dependencies), used where scenarios only need named panels.
async function addFocusPanel(
	page: Page,
	opener: Locator,
	title: string,
): Promise<void> {
	await opener.click();
	await page.getByTestId("panel-type-focus").click();
	await page.getByTestId("panel-title").fill(title);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await expect(page.getByRole("region", { name: title })).toBeVisible({
		timeout: 15000,
	});
}

// Seed a habits list + one daily habit with done logs (today + yesterday, so
// current streak = 2) and two 10-minute work focus sessions, straight into the
// user's personal workspace (views.spec seeding pattern; callers reload so the
// client re-subscribes). `today` must be the BROWSER's local day: habit_log
// dates are the user's local day (localDay), which this process's zone only
// agrees with for part of the day.
async function seedHabitAndFocus(
	email: string,
	habitTitle: string,
	today: string,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		const rows = await pool.query<{ wsId: string; ownerId: string }>(
			`select w.id as "wsId", w.owner_id as "ownerId"
			 from workspace w join "user" u on u.id = w.owner_id
			 where u.email = $1 and w.kind = 'personal'`,
			[email],
		);
		const row = rows.rows[0];
		if (!row) throw new Error("personal workspace not found");
		const listId = crypto.randomUUID();
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ($1, $2, $3, 'Seeded habits', 'habits', 'a0')`,
			[listId, row.wsId, row.ownerId],
		);
		const habitId = crypto.randomUUID();
		await pool.query(
			`insert into task (id, list_id, title, sort_key, rrule)
			 values ($1, $2, $3, 'a0', 'FREQ=DAILY')`,
			[habitId, listId, habitTitle],
		);
		for (const date of [today, shiftDay(today, -1)]) {
			await pool.query(
				`insert into habit_log (id, habit_id, date, status)
				 values ($1, $2, $3, 'done')`,
				[crypto.randomUUID(), habitId, date],
			);
		}
		for (let i = 0; i < 2; i++) {
			await pool.query(
				`insert into focus_session (id, user_id, kind, started_at, ended_at, duration_sec)
				 values ($1, $2, 'work', now(), now(), 600)`,
				[crypto.randomUUID(), row.ownerId],
			);
		}
	} finally {
		await pool.end();
	}
}

// Poll upstream Postgres until `read` returns `expected`: an expect-based sync
// barrier for reload-persistence checks (never an arbitrary sleep).
async function expectServerState<T>(
	read: (pool: Pool) => Promise<T>,
	expected: T,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await expect.poll(() => read(pool), { timeout: 15000 }).toEqual(expected);
	} finally {
		await pool.end();
	}
}

// Sharing scenario: add `userId` to the globally seeded shared workspace at
// `role` (direct upstream write; zero-cache replicates), same as sharing.spec.
async function joinShared(
	userId: string,
	role: "owner" | "admin" | "member" | "viewer",
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
	try {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1, $2, $3, $4)`,
			[crypto.randomUUID(), userId, SHARED_WORKSPACE_ID, role],
		);
	} finally {
		await pool.end();
	}
}

// Preserve sync metadata, never auth frames or task contents, for sharing failures.
type SharingSyncEvent = Record<string, unknown> & {
	kind: string;
	accountRole: "owner" | "member" | "outsider" | "viewer";
	clientGroupID?: string;
	clientID?: string;
};

function observeSharingSync(
	page: Page,
	accountRole: SharingSyncEvent["accountRole"],
): SharingSyncEvent[] {
	const events: SharingSyncEvent[] = [];
	page.on("websocket", (socket) => {
		const url = new URL(socket.url());
		if (!url.pathname.includes("/sync/")) return;
		const connection = {
			accountRole,
			clientGroupID: url.searchParams.get("clientGroupID") ?? undefined,
			clientID: url.searchParams.get("clientID") ?? undefined,
		};
		if (events.length < 100)
			events.push({
				at: Date.now(),
				kind: "connection",
				...connection,
				baseCookie: url.searchParams.get("baseCookie"),
			});
		socket.on("framereceived", ({ payload }) => {
			if (events.length >= 100) return;
			try {
				const frame: unknown = JSON.parse(payload.toString());
				if (!Array.isArray(frame)) return;
				const [kind, data] = frame as [string, Record<string, unknown>];
				if (!data || !["pokeStart", "pokePart", "pokeEnd"].includes(kind))
					return;
				const rows = Array.isArray(data.rowsPatch) ? data.rowsPatch : [];
				events.push({
					at: Date.now(),
					kind,
					...connection,
					pokeID: data.pokeID,
					baseCookie: data.baseCookie,
					cookie: data.cookie,
					gotQueriesPatch: data.gotQueriesPatch,
					desiredQueriesPatches: data.desiredQueriesPatches,
					rows: rows.map((row: Record<string, unknown>) => {
						const value = row.value as Record<string, unknown> | undefined;
						const key = row.id as Record<string, unknown> | undefined;
						return {
							op: row.op,
							table: row.tableName,
							id: value?.id ?? key?.id,
							rowKey: key,
							workspaceId: value?.workspace_id,
							role: value?.role,
							scope: value?.scope,
						};
					}),
				});
			} catch {
				events.push({
					at: Date.now(),
					kind: "unparseable-sync-frame",
					...connection,
				});
			}
		});
	});
	return events;
}

const diagnosticID = z.string().regex(/^[\w-]{1,128}$/);
const replicaSelectionSchema = z
	.object({
		accounts: z.array(diagnosticID).max(4),
		dashboards: z.array(diagnosticID).max(2),
		workspaces: z.array(diagnosticID).max(5),
		memberships: z.array(diagnosticID).max(8),
	})
	.strict();
type ReplicaSelection = z.infer<typeof replicaSelectionSchema>;

async function captureSharingReplica(selection: ReplicaSelection) {
	const startedAt = Date.now();
	const unavailable = {
		startedAt,
		finishedAt: startedAt,
		unavailable: "runner hook absent",
	};
	if (!process.env.E2E_DIAGNOSTIC_COMPOSE_ARGV) return unavailable;
	try {
		replicaSelectionSchema.parse(selection);
		const compose = z
			.array(z.string())
			.parse(JSON.parse(process.env.E2E_DIAGNOSTIC_COMPOSE_ARGV));
		if (
			compose[0] !== "compose" ||
			compose.length > 31 ||
			compose.length % 2 !== 1
		)
			throw new Error();
		for (let i = 1; i < compose.length; i += 2)
			if (
				![
					"--project-name",
					"--file",
					"-f",
					"--profile",
					"--project-directory",
				].includes(compose[i]) ||
				!compose[i + 1] ||
				compose[i + 1].length > 4096
			)
				throw new Error();
		const startup = spawnSync(
			"docker",
			[...compose, "logs", "--no-color", "--tail", "1000", "zero-cache"],
			{ encoding: "utf8", timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
		);
		const servingPaths = [
			...(startup.stdout ?? "").matchAll(
				/setting (\/data\/replica\.db(?:-serving-copy)?) to wal2 mode/g,
			),
		];
		const servingFile = servingPaths.at(-1)?.[1];
		if (startup.status !== 0 || startup.error || !servingFile)
			throw new Error("serving-proof");
		const source = readFileSync(
			new URL("./sharing-replica.mjs", import.meta.url),
			"utf8",
		);
		const output = await new Promise<string>((resolve, reject) => {
			const child = spawn(
				"docker",
				[
					...compose,
					"exec",
					"-T",
					"--env",
					`E2E_DIAGNOSTIC_SERVING_FILE=${servingFile}`,
					"zero-cache",
					"/bin/busybox",
					"timeout",
					"-s",
					"KILL",
					"4",
					"node",
					"--input-type=module",
					"--eval",
					source,
				],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);
			let stdout = "";
			let bytes = 0;
			let failure: "deadline" | "output-cap" | undefined;
			const timer = setTimeout(() => {
				failure ??= "deadline";
				child.kill("SIGKILL");
			}, 5000);
			child.stdout.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > 32 * 1024) {
					failure = "output-cap";
					child.kill("SIGKILL");
				} else stdout += chunk.toString();
			});
			child.stdin.on("error", () => {});
			child.once("error", () => {
				clearTimeout(timer);
				reject(new Error("spawn"));
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (failure || code !== 0)
					reject(
						new Error(
							failure ?? (code === 137 ? "container-kill" : "container-exit"),
						),
					);
				else resolve(stdout);
			});
			child.stdin.end(JSON.stringify(selection));
		});
		const times = { startedAt: z.number(), finishedAt: z.number() };
		const error = z
			.object({
				...times,
				stage: z.enum([
					"input",
					"open",
					"query",
					"backup",
					"rollback",
					"close",
				]),
				error: z.enum(["Error", "RangeError"]),
			})
			.strict();
		const nullableID = diagnosticID.nullable();
		const version = z.string().max(128).nullable();
		const common = {
			expectedID: diagnosticID,
			rowFound: z.union([z.literal(0), z.literal(1)]),
			id: nullableID,
			rowVersion: version,
		};
		const row = z.discriminatedUnion("table", [
			z
				.object({
					...common,
					table: z.literal("dashboard"),
					owner_id: nullableID,
					workspace_id: nullableID,
					scope: z.enum(["personal", "workspace"]).nullable(),
				})
				.strict(),
			z
				.object({
					...common,
					table: z.literal("workspace"),
					owner_id: nullableID,
					kind: z.enum(["personal", "shared"]).nullable(),
				})
				.strict(),
			z
				.object({
					...common,
					table: z.literal("membership"),
					user_id: nullableID,
					workspace_id: nullableID,
					role: z.enum(["owner", "admin", "member", "viewer"]).nullable(),
				})
				.strict(),
		]);
		const result = z
			.union([
				error,
				z
					.object({
						...times,
						servingFile: z.enum([
							"/data/replica.db",
							"/data/replica.db-serving-copy",
						]),
						journalMode: z.literal("wal2"),
						backupVerified: z.literal(true),
						metadata: z
							.array(
								z
									.object({
										stateVersion: z.string().max(128),
										replicaVersion: z.string().max(128),
										writeTimeMs: z.number().nullable(),
									})
									.strict(),
							)
							.max(1),
						rows: z.array(row).max(15),
						visibility: z
							.array(
								z
									.object({
										accountID: diagnosticID,
										dashboardID: diagnosticID,
										visible: z.union([z.literal(0), z.literal(1)]),
									})
									.strict(),
							)
							.max(8),
					})
					.strict(),
			])
			.parse(JSON.parse(output));
		if ("rows" in result) {
			if (result.servingFile !== servingFile) throw new Error("serving-proof");
			const keys = {
				dashboard: selection.dashboards,
				workspace: selection.workspaces,
				membership: selection.memberships,
			};
			if (
				result.rows.some(
					(r) =>
						!keys[r.table].includes(r.expectedID) ||
						(r.id !== null && r.id !== r.expectedID),
				) ||
				result.visibility.some(
					(v) =>
						!selection.accounts.includes(v.accountID) ||
						!selection.dashboards.includes(v.dashboardID),
				)
			)
				throw new Error("output-shape");
		}
		return {
			...result,
			servingFileProof: "worker startup WAL2 message",
			captureStartedAt: startedAt,
			captureFinishedAt: Date.now(),
		};
	} catch (error) {
		const marker =
			error instanceof Error &&
			[
				"deadline",
				"output-cap",
				"spawn",
				"container-kill",
				"container-exit",
				"output-shape",
				"serving-proof",
			].includes(error.message)
				? error.message
				: "validation";
		console.error(`dashboard sharing replica diagnostics failed: ${marker}`);
		return { startedAt, finishedAt: Date.now(), stage: marker, error: "Error" };
	}
}

async function sharingQueryHashes(accounts: Record<string, string>) {
	const root = dirname(
		createRequire(import.meta.url).resolve("@rocicorp/zero"),
	);
	if (
		JSON.parse(readFileSync(join(root, "../../../package.json"), "utf8"))
			.version !== "1.9.0"
	)
		throw new Error("Zero version mismatch");
	// The test-only hash must match the pinned cache's server-mapped AST contract.
	const { hashOfAST } = (await import(
		pathToFileURL(join(root, "../../zero-protocol/src/query-hash.js")).href
	)) as { hashOfAST: (ast: unknown) => string };
	return await Promise.all(
		Object.entries(accounts).map(async ([accountRole, accountID]) => {
			z.enum(["owner", "member", "outsider", "viewer"]).parse(accountRole);
			diagnosticID.parse(accountID);
			const names = ["dashboards.mine", "userPrefs.mine"];
			const response = await handleQueryRequest({
				schema,
				userID: accountID,
				query: {},
				body: [
					"transform",
					names.map((name) => ({ id: name, name, args: [] })),
				],
				handler: (name, args) =>
					mustGetQuery(appQueries, name).fn({
						args: args as never,
						ctx: { id: accountID },
					}),
			});
			if (
				response instanceof Response ||
				!("kind" in response) ||
				response.kind !== "QueryResponse" ||
				response.userID !== accountID ||
				response.queries.length !== 2
			)
				throw new Error("Query response failed");
			const hashes = response.queries.map((q) => {
				if (!("ast" in q)) throw new Error("Query transformation failed");
				return hashOfAST(q.ast);
			});
			return {
				accountRole,
				accountID,
				dashboardHash: hashes[0],
				prefHash: hashes[1],
			};
		}),
	);
}

async function attachSharingFailure(
	accounts: Record<string, string>,
	teamDash: string,
	soloDash: string,
	sync: SharingSyncEvent[],
): Promise<void> {
	const pool = new Pool({
		connectionString: process.env.E2E_DATABASE_URL,
		connectionTimeoutMillis: 3000,
		query_timeout: 3000,
	});
	try {
		const ids = Object.values(accounts);
		const queries = {
			accounts: `select id, deleted_at, two_factor_enabled from "user" where id = any($1)`,
			memberships: `select id, user_id, workspace_id, role from membership where user_id = any($1)`,
			preferences: `select id, home_view_ref, pinned_views, locale from user_pref where id = any($1)`,
			dashboards: `select id, owner_id, workspace_id, scope, name from dashboard where owner_id = any($1) and name = any($2)`,
		};
		const database = await Promise.all(
			Object.entries(queries).map(async ([name, sql]) => {
				try {
					const result = await pool.query(
						sql,
						name === "dashboards" ? [ids, [teamDash, soloDash]] : [ids],
					);
					return [name, result.rows];
				} catch (error) {
					console.error(
						`dashboard sharing ${name} diagnostics failed:`,
						error instanceof Error ? error.name : "unknown",
					);
					return [
						name,
						{ error: error instanceof Error ? error.name : "unknown" },
					];
				}
			}),
		);
		const state: Record<string, unknown> = Object.fromEntries(database);
		const observedGroups = [
			...new Set(
				sync.flatMap((event) =>
					event.clientGroupID ? [event.clientGroupID] : [],
				),
			),
		];
		const records = (name: string): Record<string, unknown>[] =>
			Array.isArray(state[name]) ? state[name] : [];
		const knownIDs = (values: unknown[]) =>
			[...new Set(values)].filter(
				(value): value is string => typeof value === "string",
			);
		const expected = [
			...knownIDs(records("dashboards").map((row) => row.id)).map((id) => ({
				table: "dashboard",
				rowKey: { id },
			})),
			...knownIDs([
				SHARED_WORKSPACE_ID,
				...records("memberships").map((row) => row.workspace_id),
				...records("dashboards").map((row) => row.workspace_id),
			]).map((id) => ({ table: "workspace", rowKey: { id } })),
			...knownIDs(records("memberships").map((row) => row.id)).map((id) => ({
				table: "membership",
				rowKey: { id },
			})),
		];
		const selection = replicaSelectionSchema.safeParse({
			accounts: ids,
			dashboards: knownIDs(records("dashboards").map((row) => row.id)),
			workspaces: knownIDs(
				expected
					.filter((row) => row.table === "workspace")
					.map((row) => row.rowKey.id),
			),
			memberships: knownIDs(records("memberships").map((row) => row.id)),
		});
		const replica = selection.success
			? await captureSharingReplica(selection.data)
			: { stage: "scope-cap", error: "RangeError" };
		let hashes: Awaited<ReturnType<typeof sharingQueryHashes>> = [];
		let hashError: string | undefined;
		try {
			if (!selection.success) throw new RangeError();
			hashes = await sharingQueryHashes(accounts);
		} catch (error) {
			hashError = error instanceof RangeError ? "scope-cap" : "query-transform";
			console.error(`dashboard sharing group recovery failed: ${hashError}`);
		}
		let groups: string[] = [];
		let cvr: Record<string, unknown> = {
			groups,
			expected,
			observedGroups,
			hashes,
			limits: { groups: 4, candidates: 200, rows: 200 },
			startedAt: Date.now(),
		};
		if (hashError) {
			cvr.error = hashError;
		} else {
			try {
				const client = await pool.connect();
				let transactionOpen = false;
				try {
					await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
					transactionOpen = true;
					await client.query("SET LOCAL statement_timeout = '3s'");
					// The E2E Compose stack uses Zero's default app/shard namespace.
					const candidates = await client.query<{
						accountRole: string;
						accountID: string;
						clientGroupID: string;
						dashboardMatch: boolean;
						prefMatch: boolean;
						activeDashboardMatch: boolean;
						activePrefMatch: boolean;
						instanceDeleted: boolean | null;
						lastActive: Date;
						matchedCandidates: string;
					}>(
						`with wanted as (
						 select * from jsonb_to_recordset($1::jsonb) as w("accountRole" text,
						 "accountID" text, "dashboardHash" text, "prefHash" text)
						 ), matches as (
						 select w."accountRole", w."accountID", q."clientGroupID",
						 bool_or(q."queryName" = 'dashboards.mine') as "dashboardMatch",
						 bool_or(q."queryName" = 'userPrefs.mine') as "prefMatch",
						 bool_or(q."queryName" = 'dashboards.mine' and q.deleted = false) as "activeDashboardMatch",
						 bool_or(q."queryName" = 'userPrefs.mine' and q.deleted = false) as "activePrefMatch"
						 from wanted w join "zero_0/cvr".queries q on
						 (q."queryName" = 'dashboards.mine' and q."transformationHash" = w."dashboardHash") or
						 (q."queryName" = 'userPrefs.mine' and q."transformationHash" = w."prefHash")
						 group by w."accountRole", w."accountID", q."clientGroupID"
						 ) select m.*, i."lastActive", i.deleted as "instanceDeleted",
						 count(*) over () as "matchedCandidates"
						 from matches m join "zero_0/cvr".instances i using("clientGroupID")
						 order by m."accountRole", i."lastActive" desc, m."clientGroupID" limit 200`,
						[JSON.stringify(hashes)],
					);
					const candidatesTruncated =
						Number(candidates.rows[0]?.matchedCandidates ?? 0) > 200;
					const recovery = hashes.map(({ accountRole, accountID }) => {
						const matching = candidates.rows.filter(
							(row) =>
								row.accountRole === accountRole && row.accountID === accountID,
						);
						const eligible = matching.filter(
							(row) =>
								row.instanceDeleted === false &&
								row.activeDashboardMatch &&
								row.activePrefMatch,
						);
						const selectedGroup =
							!candidatesTruncated && eligible.length === 1
								? eligible[0].clientGroupID
								: null;
						return {
							accountRole,
							accountID,
							candidateCount: matching.length,
							selectedGroup,
							ambiguous: eligible.length > 1,
							partial: matching.some(
								(row) => !row.dashboardMatch || !row.prefMatch,
							),
							status: candidatesTruncated
								? "truncated"
								: selectedGroup
									? "recovered"
									: eligible.length > 1
										? "ambiguous"
										: "not recoverable",
						};
					});
					groups = [
						...new Set(
							recovery.flatMap((row) =>
								row.selectedGroup ? [row.selectedGroup] : [],
							),
						),
					];
					cvr = {
						...cvr,
						groups,
						candidates: candidates.rows,
						recovery,
						truncated: { candidates: candidatesTruncated, groups: false },
					};
					const versions = await client.query(
						`select g.id as "clientGroupID", i.version as "metadataVersion",
						 rv.version as "rowsVersion", i."replicaVersion", i."lastActive", i.deleted as "instanceDeleted"
						 from unnest($1::text[]) g(id)
						 left join "zero_0/cvr".instances i on i."clientGroupID" = g.id
						 left join "zero_0/cvr"."rowsVersion" rv on rv."clientGroupID" = g.id
						 order by g.id limit 200`,
						[groups],
					);
					const queries = await client.query(
						`select "clientGroupID", "queryHash", "patchVersion",
						 "transformationHash", "transformationVersion", "rowSetSignature", deleted,
						 count(*) over () as "matchedRows"
						 from "zero_0/cvr".queries
						 where "clientGroupID" = any($1::text[]) and "queryName" = 'dashboards.mine'
						 order by "clientGroupID", "queryHash" limit 200`,
						[groups],
					);
					const rows = await client.query(
						`with expected as (
						 select * from jsonb_to_recordset($2::jsonb) as e("table" text, "rowKey" jsonb)
						 ), q as (
						 select "clientGroupID", "queryHash" from "zero_0/cvr".queries
						 where "clientGroupID" = any($1::text[]) and "queryName" = 'dashboards.mine'
						 )
						 select g.id as "clientGroupID", e."table", e."rowKey",
						 r."clientGroupID" is not null as "rowFound", r."schema",
						 r."rowVersion", r."patchVersion", r."refCounts",
						 r."refCounts" is null as "nullRefs", q."queryHash",
						 r."refCounts" -> q."queryHash" as "dashboardQueryRefCount",
						 count(*) over () as "matchedRows"
						 from unnest($1::text[]) g(id) cross join expected e
						 left join "zero_0/cvr".rows r on r."clientGroupID" = g.id
						 and r."schema" = '' and r."table" = e."table" and r."rowKey" = e."rowKey"
						 left join q on q."clientGroupID" = g.id
						 order by g.id, e."table", e."rowKey", q."queryHash" limit 200`,
						[groups, JSON.stringify(expected)],
					);
					await client.query("COMMIT");
					transactionOpen = false;
					cvr = {
						...cvr,
						truncated: {
							candidates: candidatesTruncated,
							groups: false,
							queries: Number(queries.rows[0]?.matchedRows ?? 0) > 200,
							rows: Number(rows.rows[0]?.matchedRows ?? 0) > 200,
						},
						versions: versions.rows,
						queries: queries.rows,
						rows: rows.rows,
						...(groups.length === 0
							? { unavailable: "no unique eligible account group" }
							: {}),
					};
				} finally {
					try {
						if (transactionOpen) await client.query("ROLLBACK");
					} catch (error) {
						console.error(
							"dashboard sharing CVR rollback failed:",
							error instanceof Error ? error.name : "unknown",
						);
					} finally {
						client.release();
					}
				}
			} catch (error) {
				console.error(
					"dashboard sharing CVR diagnostics failed:",
					error instanceof Error ? error.name : "unknown",
				);
				cvr.error = error instanceof Error ? error.name : "unknown";
			}
		}
		cvr.finishedAt = Date.now();
		await test.info().attach("dashboard-sharing-state", {
			contentType: "application/json",
			body: JSON.stringify({
				accounts,
				expected: { teamDash, soloDash, workspaceId: SHARED_WORKSPACE_ID },
				database: state,
				replica,
				snapshotRelationship:
					"Replica captured before CVR; independent committed snapshots, not atomic or the ViewSyncer's held transaction",
				cvr,
				sync,
			}),
		});
	} finally {
		await pool.end();
	}
}

// Gate per design 2.14: zero serious/critical violations. Freeze animations so
// axe samples the settled frame (matches views.spec exactly).
async function expectNoSeriousA11y(page: Page, surface: string): Promise<void> {
	await page.addStyleTag({
		content:
			"*,*::before,*::after{animation:none!important;transition:none!important}",
	});
	const { violations } = await new AxeBuilder({ page }).analyze();
	const serious = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	const minor = violations.filter(
		(v) => v.impact !== "serious" && v.impact !== "critical",
	);
	if (minor.length > 0)
		console.log(
			`a11y[${surface}] moderate/minor:`,
			minor.map((v) => v.id).join(", "),
		);
	if (serious.length > 0)
		console.error(
			`a11y[${surface}] serious/critical:`,
			JSON.stringify(
				serious.map((v) => ({ id: v.id, nodes: v.nodes.length })),
				null,
				2,
			),
		);
	expect(serious, `serious/critical a11y violations on ${surface}`).toEqual([]);
}

// --- Scenarios 1+2: create dashboard, add view-ref + inline panels, complete
// a task from the panel and see the counter drop (task.complete wiring) ---
test("dashboard: sidebar create, view-ref tasks panel + inline counter, completion drops the count", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("d1"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "D1");
	await openListDesktop(page, "D1");
	await addTask(page, "Dash task one");
	await addTask(page, "Dash task two");

	// A saved view (empty filter = all my tasks) to reference from the panel.
	const viewName = `Panel view ${Date.now()}`;
	await page.getByTestId("sidebar-create").click();
	await page.getByTestId("new-view").click();
	await page.getByTestId("view-name").fill(viewName);
	await page.getByTestId("view-save").click();
	await expect(page.getByTestId("view-surface")).toBeVisible({
		timeout: 15000,
	});

	// New dashboard from the sidebar -> opens on the empty state.
	const dashName = `Board ${Date.now()}`;
	await createDashboard(page, dashName);
	await expect(page.getByTestId("dashboard-empty")).toBeVisible();

	// Empty-state CTA enters edit mode and opens the add-panel dialog: a tasks
	// panel referencing the saved view.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();
	await pickSelect(page, page.getByTestId("panel-view-pick"), viewName);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const tasksPanel = page.getByTestId("tasks-panel");
	await expect(
		tasksPanel.getByText("Dash task one", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		tasksPanel.getByText("Dash task two", { exact: true }),
	).toBeVisible();

	// Second panel: an inline-filter counter over open (not done) tasks.
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-counter").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("add-condition").click();
	const condition = page
		.getByRole("group", { name: "Filter condition", exact: true })
		.first();
	await pickSelect(page, condition.getByTestId("field-select"), "Status");
	await pickSelect(page, condition.getByTestId("value-control"), "Not done");
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await expect(page.getByTestId("counter-tile")).toHaveText("2", {
		timeout: 15000,
	});

	// Leave edit mode; both panels keep rendering.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Edit");
	await expect(
		tasksPanel.getByText("Dash task one", { exact: true }),
	).toBeVisible();

	// Complete a task from the panel row: the row leaves the panel (its view does
	// not ask about completion, so done rows stay hidden) AND the counter drops,
	// proving the row routes through the live task.complete path.
	const checkbox = tasksPanel.getByRole("checkbox", { name: "Dash task one" });
	await checkbox.click();
	await expect(page.getByTestId("counter-tile")).toHaveText("1", {
		timeout: 15000,
	});
	await expect(
		tasksPanel.getByText("Dash task one", { exact: true }),
	).toHaveCount(0);
	await expect(
		tasksPanel.getByText("Dash task two", { exact: true }),
	).toBeVisible();
});

// --- Scenario 3: edit mode reorder (persists), resize preset, remove ---
test("dashboard edit mode: drag reorder persists, size preset applies, remove with confirm", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("d3"));
	await waitWorkspaceReady(page);

	const dashName = `Editable ${Date.now()}`;
	await createDashboard(page, dashName);

	// Two named panels (focus type needs no source), added in edit mode.
	await addFocusPanel(page, page.getByTestId("dashboard-empty-add"), "Alpha");
	await addFocusPanel(page, page.getByTestId("add-panel"), "Beta");
	const frames = page.getByTestId("panel-frame");
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Alpha");
	await expect(frames.nth(1)).toHaveAttribute("aria-label", "Beta");

	// Drag Alpha's handle onto Beta -> order flips. Intermediate pointer steps
	// clear dnd-kit's activation distance (views.spec board pattern).
	const handle = await page
		.getByRole("region", { name: "Alpha" })
		.getByTestId("panel-drag")
		.boundingBox();
	const target = await page.getByRole("region", { name: "Beta" }).boundingBox();
	if (!handle || !target) throw new Error("missing drag targets");
	await page.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		handle.x + handle.width / 2,
		handle.y + handle.height / 2 + 12,
		{ steps: 6 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2,
		{ steps: 20 },
	);
	await page.mouse.move(
		target.x + target.width / 2,
		target.y + target.height / 2 + 4,
		{ steps: 5 },
	);
	await page.mouse.up();
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Beta", {
		timeout: 15000,
	});

	// The order persists across a reload (panels JSON written, not local state).
	await page.reload();
	await waitWorkspaceReady(page);
	await openDashboardFromSidebar(page, dashName);
	await expect(frames.nth(0)).toHaveAttribute("aria-label", "Beta", {
		timeout: 15000,
	});
	await expect(frames.nth(1)).toHaveAttribute("aria-label", "Alpha");

	// Re-enter edit mode; resize Beta to Full width via the "..." menu preset.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Done");
	const beta = page.getByRole("region", { name: "Beta" });
	await beta.getByTestId("panel-menu").click();
	await page.getByTestId("panel-resize").click();
	await page.getByTestId("panel-size-full").click();
	await expect(beta.locator("..")).toHaveClass(/md:col-span-12/, {
		timeout: 15000,
	});

	// Without a docked task detail the grid stays 12 columns at any md width,
	// even where the content is under 672px (900px viewport, 280px sidebar).
	await page.setViewportSize({ width: 900, height: 800 });
	await expect
		.poll(() =>
			page
				.getByTestId("dashboard-grid")
				.evaluate(
					(el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
				),
		)
		.toBe(12);
	await page.setViewportSize({ width: 1280, height: 720 });

	// Remove Beta, accepting the in-app AlertDialog. A page.once("dialog")
	// handler would silently do nothing here: the confirm is a DOM dialog, not
	// a native one, so the click must be driven like any other control.
	await beta.getByTestId("panel-menu").click();
	await page.getByTestId("panel-remove").click();
	await page.getByTestId("confirm-accept").click();
	await expect(page.getByRole("region", { name: "Beta" })).toHaveCount(0, {
		timeout: 15000,
	});
	await expect(page.getByRole("region", { name: "Alpha" })).toBeVisible();
});

// --- Scenario 4: sharing — workspace-shared visible to members only, personal
// stays private, viewer sees it read-only ---
test("dashboard sharing: member sees workspace dashboard, outsider and co-member of personal do not, viewer read-only", async ({
	browser,
}) => {
	test.setTimeout(150_000);
	const ctxOwner = await browser.newContext();
	const ctxMember = await browser.newContext();
	const ctxOutsider = await browser.newContext();
	const ctxViewer = await browser.newContext();
	const accounts: Record<string, string> = {};
	const teamDash = `Team ${Date.now()}`;
	const soloDash = `Solo ${Date.now()}`;
	const sync: SharingSyncEvent[][] = [];
	try {
		// Owner joins the seeded shared workspace and creates a workspace-shared
		// dashboard in it, plus a personal one.
		const pOwner = await ctxOwner.newPage();
		sync.push(observeSharingSync(pOwner, "owner"));
		const ownerId = await signUp(pOwner, uniqueEmail("d4-owner"));
		accounts.owner = ownerId;
		await joinShared(ownerId, "owner");
		await pOwner.reload();
		await waitWorkspaceReady(pOwner);
		await openWorkspaceSwitcher(pOwner);
		await expect(workspaceOption(pOwner, "Household")).toBeVisible({
			timeout: 15000,
		});
		await pOwner.keyboard.press("Escape");
		await createDashboard(pOwner, teamDash, { workspace: "Household" });
		await createDashboard(pOwner, soloDash);

		// A second member sees the workspace dashboard, never the personal one.
		const pMember = await ctxMember.newPage();
		sync.push(observeSharingSync(pMember, "member"));
		const memberId = await signUp(pMember, uniqueEmail("d4-member"));
		accounts.member = memberId;
		await joinShared(memberId, "member");
		await pMember.reload();
		await waitWorkspaceReady(pMember);
		await expect(
			sidebarLists(pMember).getByRole("button", {
				name: teamDash,
				exact: true,
			}),
		).toBeVisible({ timeout: 15000 });
		await expect(
			sidebarLists(pMember).getByRole("button", {
				name: soloDash,
				exact: true,
			}),
		).toHaveCount(0);

		// A non-member never sees it (dashboards section is rendered, entry absent).
		const pOutsider = await ctxOutsider.newPage();
		sync.push(observeSharingSync(pOutsider, "outsider"));
		accounts.outsider = await signUp(pOutsider, uniqueEmail("d4-outsider"));
		await waitWorkspaceReady(pOutsider);
		await pOutsider.getByTestId("sidebar-create").click();
		await expect(pOutsider.getByTestId("new-dashboard")).toBeVisible();
		await pOutsider.keyboard.press("Escape");
		await expect(
			sidebarLists(pOutsider).getByRole("button", {
				name: teamDash,
				exact: true,
			}),
		).toHaveCount(0);

		// A viewer sees and opens the dashboard but gets no edit affordances.
		const pViewer = await ctxViewer.newPage();
		sync.push(observeSharingSync(pViewer, "viewer"));
		const viewerId = await signUp(pViewer, uniqueEmail("d4-viewer"));
		accounts.viewer = viewerId;
		await joinShared(viewerId, "viewer");
		await pViewer.reload();
		await waitWorkspaceReady(pViewer);
		await expect(
			sidebarLists(pViewer).getByRole("button", {
				name: teamDash,
				exact: true,
			}),
		).toBeVisible({ timeout: 15000 });
		await openDashboardFromSidebar(pViewer, teamDash);
		await expect(
			pViewer.getByRole("heading", { name: teamDash, level: 1 }),
		).toBeVisible();
		await expect(pViewer.getByTestId("dashboard-empty")).toBeVisible();
		await expect(pViewer.getByTestId("dashboard-edit")).toHaveCount(0);
		await expect(pViewer.getByTestId("dashboard-empty-add")).toHaveCount(0);
	} catch (error) {
		try {
			await attachSharingFailure(accounts, teamDash, soloDash, sync.flat());
		} catch (diagnosticError) {
			console.error(
				"dashboard sharing diagnostics failed:",
				diagnosticError instanceof Error ? diagnosticError.name : "unknown",
			);
		}
		throw error;
	} finally {
		await ctxOwner.close();
		await ctxMember.close();
		await ctxOutsider.close();
		await ctxViewer.close();
	}
});

// --- Scenario 5: streak + focus panels over seeded habit logs and sessions ---
test("dashboard panels: streak shows seeded streak/adherence, focus shows count/minutes", async ({
	page,
}) => {
	const email = uniqueEmail("d5");
	const HABIT = "Morning stretch";
	await signUp(page, email);
	await waitWorkspaceReady(page);

	// Seed a habit (daily, done today + yesterday) and two 10-min work sessions;
	// reload so the client syncs them before the panels are built.
	await seedHabitAndFocus(email, HABIT, await browserToday(page));
	await page.reload();
	await waitWorkspaceReady(page);

	const dashName = `Habits board ${Date.now()}`;
	await createDashboard(page, dashName);

	// Streak panel over the seeded habit.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-streak").click();
	await page.getByRole("checkbox", { name: HABIT }).click();
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const streakRow = page.getByTestId("streak-row");
	await expect(streakRow).toBeVisible({ timeout: 15000 });
	await expect(streakRow).toHaveAttribute(
		"aria-label",
		/2 day streak, \d+% on track/,
	);
	await expect(streakRow.getByText(HABIT, { exact: true })).toBeVisible();

	// Focus panel (range: today) over the seeded sessions.
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-focus").click();
	await expect(page.getByTestId("panel-range-today")).toBeChecked();
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	const focusPanel = page.getByTestId("focus-panel");
	await expect(focusPanel).toBeVisible({ timeout: 15000 });
	// Count + unit render as one paragraph ("2focus sessions").
	await expect(focusPanel.getByText(/^2\s*focus sessions$/)).toBeVisible();
	await expect(focusPanel.getByTestId("focus-minutes")).toHaveText(
		"20 min focused",
		{ timeout: 15000 },
	);
});

// --- Scenario 6: g d, palette entry, set-as-home round-trip, delete fallback ---
test("dashboard nav: g d and palette open it, home ref survives reload, delete falls back to Today", async ({
	page,
}) => {
	// user_pref is keyed by user id; scope the sync barriers to this user so
	// other accounts cannot skew the unfiltered count.
	const userId = await signUp(page, uniqueEmail("d6"));
	await waitWorkspaceReady(page);

	const dashName = `Homey ${Date.now()}`;
	await createDashboard(page, dashName);

	// Move to Today, then g d navigates to the first dashboard.
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("d");
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });

	// Back to Today; the palette "Dashboard: <name>" entry navigates too.
	await blur(page);
	await page.keyboard.press("g");
	await page.keyboard.press("t");
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await page.keyboard.press("ControlOrMeta+k");
	const palette = page.getByRole("combobox", {
		name: "Command palette search",
	});
	await expect(palette).toBeVisible();
	await palette.fill(dashName);
	await expect(
		page.getByRole("option", { name: `Dashboard: ${dashName}` }),
	).toBeVisible({ timeout: 15000 });
	await page.keyboard.press("Enter");
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });
	// Palette teardown before further interaction (views.spec flake guard).
	await expect(palette).toBeHidden({ timeout: 15000 });

	// Set as home; the reopened menu reflects the checked state (also gives the
	// pref write time to sync), then a reload lands on the dashboard.
	await page.getByTestId("dashboard-actions").click();
	await page.getByTestId("dashboard-set-home").click();
	// Wait for the menu teardown before re-opening, else the trigger click races
	// the closing menu and gets swallowed (Radix pointer-events race).
	await expect(page.getByTestId("dashboard-set-home")).toBeHidden({
		timeout: 15000,
	});
	await page.getByTestId("dashboard-actions").click();
	await expect(page.getByTestId("dashboard-set-home")).toBeVisible({
		timeout: 15000,
	});
	await expect(page.getByTestId("dashboard-set-home")).toHaveAttribute(
		"aria-checked",
		"true",
		{ timeout: 15000 },
	);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("dashboard-set-home")).toBeHidden();
	// Sync barrier: reload only once the pref write reached the server (a reload
	// that races the in-flight push is a Zero durability concern, not the
	// home-ref behavior under test).
	await expectServerState(
		async (pool) =>
			(
				await pool.query(
					`select count(*)::int as c from user_pref
					 where id = $1 and home_view_ref is not null`,
					[userId],
				)
			).rows[0].c,
		1,
	);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		page.getByRole("heading", { name: dashName, level: 1 }),
	).toBeVisible({ timeout: 15000 });

	// Delete the home dashboard (confirm accepted) -> falls back to Today, and
	// the fallback survives a reload (home ref was cleared, not left dangling).
	await page.getByTestId("dashboard-actions").click();
	await page.getByTestId("dashboard-delete").click();
	await page.getByTestId("confirm-accept").click();
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	// Sync barrier: delete + pref clear reached the server before the reload.
	await expectServerState(async (pool) => {
		const d = await pool.query(
			`select count(*)::int as c from dashboard where name = $1`,
			[dashName],
		);
		const p = await pool.query(
			`select count(*)::int as c from user_pref
			 where id = $1 and home_view_ref is not null`,
			[userId],
		);
		return d.rows[0].c + p.rows[0].c;
	}, 0);
	await page.reload();
	await waitWorkspaceReady(page);
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15000 });
	await expect(
		sidebarLists(page).getByRole("button", { name: dashName, exact: true }),
	).toHaveCount(0);
});

// --- Scenario 7: axe merge gate on the dashboard surfaces ---
test("a11y: no serious/critical violations on dashboard view, edit mode, add-panel dialog", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await signUp(page, uniqueEmail("axe-dash"));
	await waitWorkspaceReady(page);

	await createListDesktop(page, "AxeDash");
	await openListDesktop(page, "AxeDash");
	await addTask(page, "Axe dash item");

	const dashName = `Axe board ${Date.now()}`;
	await createDashboard(page, dashName);

	// Populate: inline tasks panel + inline counter + focus panel.
	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await page.getByTestId("add-panel").click();
	await page.getByTestId("panel-type-counter").click();
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await page.getByTestId("panel-save").click();
	await expectPanelDialogClosed(page);
	await addFocusPanel(page, page.getByTestId("add-panel"), "Focus check");

	// Populated view mode.
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Edit");
	await expect(
		page.getByTestId("tasks-panel").getByText("Axe dash item", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await expectNoSeriousA11y(page, "dashboard view");

	// Edit mode active (drag handles + panel menus + ghost tile).
	await page.getByTestId("dashboard-edit").click();
	await expect(page.getByTestId("dashboard-edit")).toHaveText("Done");
	await expect(page.getByTestId("add-panel")).toBeVisible();
	await expectNoSeriousA11y(page, "dashboard edit mode");

	// AddPanelDialog open (type step).
	await page.getByTestId("add-panel").click();
	await expect(page.getByTestId("panel-type-tasks")).toBeVisible();
	await expectNoSeriousA11y(page, "add panel dialog");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("panel-type-tasks")).toBeHidden({
		timeout: 15000,
	});
});

// --- Scenario: a blocked Add panel states its reason ---
// On a fresh account there are no saved views, and Source defaults to "Saved
// view" -- so the only hint that the picker is empty used to live inside the
// closed dropdown while the Add button sat greyed out with nothing on screen
// explaining it.
test("add panel: the disabled save states why, and clears when the block does", async ({
	page,
}) => {
	await signUp(page, uniqueEmail("d-reason"));
	await waitWorkspaceReady(page);
	await createDashboard(page, `Reasons ${Date.now()}`);

	await page.getByTestId("dashboard-empty-add").click();
	await page.getByTestId("panel-type-tasks").click();

	const reason = page.getByTestId("panel-blocked-reason");
	const save = page.getByTestId("panel-save");
	await expect(save).toBeDisabled();
	await expect(reason).toBeVisible();
	await expect(reason).toContainText("No saved views yet");

	// Switching to a custom filter removes the block: an empty filter group is a
	// legal source, so the reason must disappear rather than change.
	await pickSelect(
		page,
		page.getByTestId("panel-source-mode"),
		"Custom filter",
	);
	await expect(reason).toBeHidden();
	await expect(save).toBeEnabled();

	// DialogFooter carries -mx-4 -mb-4 to offset a padded DialogContent; this
	// dialog uses p-0, so nothing offset them and the footer hung 16px past the
	// dialog on both sides and the bottom. Measured, not eyeballed -- a declared
	// rule can be inert, so this asserts the resolved geometry.
	const overhang = await page.evaluate(() => {
		const footer = document.querySelector('[data-slot="dialog-footer"]');
		const panel = footer?.closest('[role="dialog"]');
		if (!footer || !panel) return null;
		const f = footer.getBoundingClientRect();
		const p = panel.getBoundingClientRect();
		return {
			start: Math.round(p.left - f.left),
			end: Math.round(f.right - p.right),
			bottom: Math.round(f.bottom - p.bottom),
		};
	});
	expect(overhang).not.toBeNull();
	expect(overhang).toEqual({ start: 0, end: 0, bottom: 0 });

	// Same class of defect one layer up: this dialog asked for max-w-lg (512px)
	// unprefixed, which tailwind-merge keeps alongside the base sm:max-w-sm, and
	// the variant wins at every width >= 640px -- so it rendered at 384px. A
	// class assertion passes against that inert form; only the resolved box
	// distinguishes them.
	const box = await page.getByRole("dialog").boundingBox();
	expect(box).not.toBeNull();
	expect(box?.width).toBeGreaterThan(500);
});
