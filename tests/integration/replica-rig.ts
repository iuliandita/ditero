// Spawns real `bun src/server/index.ts` processes against one database.
//
// This is the only harness in the repo that can observe the durability claims
// the pipeline makes: leader election across processes, SKIP LOCKED partition
// across processes, and recovery after a process dies mid-flight. Everything
// else in tests/integration drives the same functions in one process, where a
// crash is a thrown error rather than a lost transaction.
//
// `bun src/server/index.ts`, never `bun run dev:server`: --hot leaves a child
// alive after the parent is SIGKILLed, so the crash tests would silently keep
// running against a live worker and assert nothing.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../src/db/schema.ts";

type Database = NodePgDatabase<typeof tables>;

export const RIG_BASE_PORT = 3181;

export type RigTiming = {
	schedulerTickMs: number;
	lateThresholdMs: number;
	graceMs: number;
	workerTickMs: number;
	leaseMs: number;
	adapterDeadlineMs: number;
	batchSize: number;
	sendConcurrency: number;
};

// Two hard floors bound how fast this can be tuned, and both are worth stating
// because the obvious sub-second values do not do what they look like:
//
//  - croner quantizes to whole seconds (`Math.max(1, Math.round(ms / 1000))` in
//    both startScheduler and startWorker), so any tick under 1500ms runs at 1s.
//    The ticks are set to 1000 rather than to a smaller number that silently
//    rounds up to the same thing.
//  - config/worker.ts charges a fixed 5s database allowance per wave, and one
//    wave of (adapterDeadline + 5s) must stay under the lease -- so the lease
//    cannot go below ~6s however the rest is tuned.
//
// The values the config DOES honor at sub-second precision (grace, late
// threshold, lease, adapter deadline) are set as tight as those checks allow.
export const RIG_TIMING: RigTiming = {
	schedulerTickMs: 1_000,
	lateThresholdMs: 2_000,
	graceMs: 3_600_000,
	workerTickMs: 1_000,
	leaseMs: 7_000,
	adapterDeadlineMs: 1_500,
	batchSize: 5,
	sendConcurrency: 5,
};

export type RigOptions = {
	databaseURL: string;
	// One entry per replica: that replica's extra environment, "K=V,K2=V2"
	// (DITERO_TEST_CRASH_POINT, mostly). Length decides the replica count.
	replicaEnv: string[];
	tapCIDR: string;
	basePort?: number;
	timing?: RigTiming;
};

export type Replica = {
	id: string;
	port: number;
	process: ChildProcess | null;
	exited: boolean;
};

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
	label: string,
	predicate: () => Promise<boolean>,
	timeoutMs = 30_000,
	intervalMs = 150,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline)
			throw new Error(`rig: timed out waiting: ${label}`);
		await sleep(intervalMs);
	}
}

export class ReplicaRig {
	readonly replicas: Replica[];
	private readonly options: RigOptions;
	private readonly timing: RigTiming;
	private readonly extraEnv: string[];
	private readonly reap: () => void;

	constructor(options: RigOptions) {
		this.options = options;
		this.timing = options.timing ?? RIG_TIMING;
		// Copied: launch/restart rewrite entries, and aliasing the caller's array
		// would mutate the literal a test declared inline.
		this.extraEnv = [...options.replicaEnv];
		const base = options.basePort ?? RIG_BASE_PORT;
		this.replicas = options.replicaEnv.map((_, index) => ({
			// Deterministic, and the value the completion fence compares against:
			// the two-replica tests assert both of these appear in claimed_by.
			id: `rig-${index}`,
			port: base + index,
			process: null,
			exited: true,
		}));
		// afterAll covers a thrown test; it does NOT cover a hard-killed vitest
		// worker (hook timeout, --test-timeout, CI cancel). A surviving replica is
		// bound to a fixed port and keeps scanning the shared database, which
		// poisons every later run on this machine.
		this.reap = () => {
			for (const replica of this.replicas) replica.process?.kill("SIGKILL");
		};
		process.once("exit", this.reap);
		process.once("SIGINT", this.reap);
		process.once("SIGTERM", this.reap);
	}

	private envFor(index: number): NodeJS.ProcessEnv {
		const replica = this.replicas[index];
		const t = this.timing;
		// A minimal base, never `...process.env`: a developer with any DITERO_*
		// knob exported would otherwise get a differently-tuned rig and a failure
		// that reproduces on no other machine. PATH is what `bun` needs to run.
		return {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			DATABASE_URL: this.options.databaseURL,
			NODE_ENV: "test",
			API_PORT: String(replica.port),
			DITERO_REPLICA_ID: replica.id,
			BETTER_AUTH_SECRET: "integration-only-better-auth-secret",
			BETTER_AUTH_URL: `http://localhost:${replica.port}`,
			DITERO_PUBLIC_URL: `http://localhost:${replica.port}`,
			DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			DITERO_REGISTRATION_MODE: "bootstrap",
			DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS: this.options.tapCIDR,
			DITERO_SCHEDULER_TICK_MS: String(t.schedulerTickMs),
			DITERO_SCHEDULER_LATE_THRESHOLD_MS: String(t.lateThresholdMs),
			DITERO_SCHEDULER_GRACE_MS: String(t.graceMs),
			DITERO_WORKER_TICK_MS: String(t.workerTickMs),
			DITERO_WORKER_LEASE_MS: String(t.leaseMs),
			DITERO_NOTIFY_DEADLINE_MS: String(t.adapterDeadlineMs),
			DITERO_WORKER_BATCH_SIZE: String(t.batchSize),
			DITERO_WORKER_CONCURRENCY: String(t.sendConcurrency),
			// The overdue sweep shares the scan's leader lock family and would
			// otherwise fire inside every test; push it past any test's lifetime.
			DITERO_OVERDUE_SWEEP_MS: "3600000",
			...parseEnv(this.extraEnv[index]),
		};
	}

	async start(index?: number): Promise<void> {
		const indexes =
			index === undefined ? this.replicas.map((_, i) => i) : [index];
		for (const i of indexes) this.spawnOne(i);
		await Promise.all(indexes.map((i) => this.waitHealthy(i)));
	}

	// Spawn without waiting for /health: a replica armed with a crash point can
	// reach that point before the listener answers, and waiting would turn the
	// expected suicide into a boot failure.
	launch(index: number, env?: string): void {
		if (env !== undefined) this.extraEnv[index] = env;
		this.spawnOne(index);
	}

	async stop(index: number): Promise<void> {
		if (this.replicas[index].exited) return;
		this.kill(index);
		await this.waitForExit(index);
	}

	private spawnOne(index: number): void {
		const replica = this.replicas[index];
		const child = spawn("bun", ["src/server/index.ts"], {
			env: this.envFor(index),
			stdio: ["ignore", "pipe", "pipe"],
		});
		replica.process = child;
		replica.exited = false;
		child.once("exit", () => {
			replica.exited = true;
		});
		// Surfaced on failure only: a replica that refuses to boot otherwise
		// shows up as an opaque health-check timeout.
		const tag = `[${replica.id}]`;
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (text) console.error(`${tag} ${text}`);
		});
	}

	// Ports are fixed, so /health alone is not proof this rig owns the listener:
	// a stale replica or a developer's own server on the port answers it while
	// our child is dying of EADDRINUSE, and the suite then drives a ghost.
	// /health echoes DITERO_REPLICA_ID; only a matching id counts.
	//
	// Fixed ports also mean two concurrent CI jobs on one host collide. Accepted:
	// the existing e2e already pins 3000/5173/55432.
	private async waitHealthy(index: number): Promise<void> {
		const replica = this.replicas[index];
		await waitFor(
			`replica ${replica.id} healthy on :${replica.port}`,
			async () => {
				if (replica.exited) {
					throw new Error(`rig: replica ${replica.id} exited before boot`);
				}
				try {
					const response = await fetch(
						`http://localhost:${replica.port}/health`,
					);
					if (!response.ok) return false;
					const body = (await response.json()) as { replica?: string | null };
					if (body.replica === replica.id) return true;
					throw new Error(
						`rig: :${replica.port} is owned by ${body.replica ?? "an unidentified process"}, not ${replica.id}`,
					);
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("rig:")) {
						throw error;
					}
					return false;
				}
			},
			45_000,
		);
	}

	kill(index: number, signal: NodeJS.Signals = "SIGKILL"): void {
		this.replicas[index].process?.kill(signal);
	}

	// A replica armed with DITERO_TEST_CRASH_POINT kills itself; tests wait for
	// that rather than racing it with an external signal.
	async waitForExit(index: number, timeoutMs = 30_000): Promise<void> {
		await waitFor(
			`replica ${this.replicas[index].id} to exit`,
			async () => this.replicas[index].exited,
			timeoutMs,
		);
	}

	async killAll(): Promise<void> {
		this.reap();
		// The process-level safety net is per rig instance; leaving it attached
		// would accumulate listeners across every rig a run creates.
		process.off("exit", this.reap);
		process.off("SIGINT", this.reap);
		process.off("SIGTERM", this.reap);
		await Promise.all(
			this.replicas.map((replica, index) =>
				replica.exited ? Promise.resolve() : this.waitForExit(index, 10_000),
			),
		).catch(() => {});
	}

	// Restart a dead replica, optionally disarming (or re-arming) its crash
	// point: every crash test needs a live worker afterwards to observe the
	// recovery.
	async restart(index: number, env?: string): Promise<void> {
		if (env !== undefined) this.extraEnv[index] = env;
		this.spawnOne(index);
		await this.waitHealthy(index);
	}
}

// "KEY=value,KEY2=value2" -- kept trivial on purpose; the only consumer is the
// crash point.
function parseEnv(raw: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const pair of raw.split(",")) {
		if (!pair) continue;
		const at = pair.indexOf("=");
		if (at < 0) throw new Error(`rig: malformed env entry "${pair}"`);
		env[pair.slice(0, at)] = pair.slice(at + 1);
	}
	return env;
}

// --- Fixtures -------------------------------------------------------------
// Shared by both rig suites. Written straight to the database rather than
// through the API: what is under test is the pipeline's process behavior, and
// the fixture is only the row shape the scheduler scans for.

export type SeededUser = { id: string; topic: string };

export async function seedUser(
	database: Database,
	id: string,
	tapUrl: string,
): Promise<SeededUser> {
	const topic = `rig-${id}`;
	await database.insert(tables.user).values({
		id,
		name: id,
		email: `${id}@rig.invalid`,
	});
	// Timezone UTC explicitly: the scan expands reminderTime in the list
	// owner's stored zone, and the fixture builds its "HH:MM" in UTC.
	await database.insert(tables.userPref).values({ id, timezone: "UTC" });
	// serverUrl/topic are public channel fields, so this is exactly what the
	// send path reads back -- no token, no envelope.
	await database.insert(tables.notificationChannel).values({
		id: randomUUID(),
		userId: id,
		kind: "ntfy",
		config: { serverUrl: tapUrl, topic },
		enabled: true,
	});
	return { id, topic };
}

export type SeededScope = {
	workspaceId: string;
	listId: string;
	ownerId: string;
};

export async function seedWorkspace(
	database: Database,
	prefix: string,
	ownerId: string,
	memberIds: string[],
	listKind: (typeof tables.listKindEnum.enumValues)[number] = "tasks",
): Promise<SeededScope> {
	const workspaceId = `${prefix}-ws`;
	const listId = `${prefix}-list`;
	await database.insert(tables.workspace).values({
		id: workspaceId,
		name: prefix,
		ownerId,
		kind: "shared",
	});
	for (const userId of memberIds) {
		await database.insert(tables.membership).values({
			id: randomUUID(),
			userId,
			workspaceId,
			role: userId === ownerId ? "owner" : "member",
		});
	}
	await database.insert(tables.list).values({
		id: listId,
		workspaceId,
		ownerId,
		title: prefix,
		kind: listKind,
		sortKey: "a0",
	});
	return { workspaceId, listId, ownerId };
}

// "HH:MM" in UTC, `minutesAgo` in the past. Paired with dueAt = now, the scan
// expands exactly one occurrence, that many minutes old, inside the grace
// window.
export function reminderTimeAgo(minutesAgo: number): string {
	const at = new Date(Date.now() - minutesAgo * 60_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

export type ReminderTaskFields = {
	repeatEveryMin?: number;
	maxRepeats?: number;
	fallbackUserId?: string;
	assignees?: string[];
	minutesAgo?: number;
};

export async function seedReminderTask(
	database: Database,
	scope: SeededScope,
	id: string,
	fields: ReminderTaskFields = {},
): Promise<string> {
	await database.insert(tables.task).values({
		id,
		listId: scope.listId,
		title: id,
		sortKey: "a0",
		dueAt: new Date(),
		reminderTime: reminderTimeAgo(fields.minutesAgo ?? 2),
		repeatEveryMin: fields.repeatEveryMin ?? null,
		maxRepeats: fields.maxRepeats ?? null,
		fallbackUserId: fields.fallbackUserId ?? null,
	});
	for (const userId of fields.assignees ?? []) {
		await database
			.insert(tables.taskAssignee)
			.values({ id: `${id}:${userId}`, taskId: id, userId });
	}
	return id;
}

// Every replica ticks the moment it boots, so a leftover row from an earlier
// file in this (serial) suite would be delivered to the rig's tap and counted.
async function wipeNotificationTables(database: Database): Promise<void> {
	await database.execute(sql`
		truncate table delivery_attempt, ack_capability, notification_outbox,
			reminder_state, rate_bucket restart identity cascade
	`);
}

export async function wipeRigFixture(
	database: Database,
	userIds: string[],
	workspaceIds: string[],
): Promise<void> {
	await wipeNotificationTables(database);
	const lists = await database
		.select({ id: tables.list.id })
		.from(tables.list)
		.where(inArray(tables.list.workspaceId, workspaceIds));
	const listIds = lists.map((row) => row.id);
	if (listIds.length > 0) {
		const taskRows = await database
			.select({ id: tables.task.id })
			.from(tables.task)
			.where(inArray(tables.task.listId, listIds));
		const taskIds = taskRows.map((row) => row.id);
		if (taskIds.length > 0) {
			await database
				.delete(tables.taskAssignee)
				.where(inArray(tables.taskAssignee.taskId, taskIds));
			await database
				.delete(tables.task)
				.where(inArray(tables.task.id, taskIds));
		}
		await database.delete(tables.list).where(inArray(tables.list.id, listIds));
	}
	await database
		.delete(tables.membership)
		.where(inArray(tables.membership.workspaceId, workspaceIds));
	await database
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, workspaceIds));
	await database
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, userIds));
	await database
		.delete(tables.userPref)
		.where(inArray(tables.userPref.id, userIds));
	await database.delete(tables.user).where(inArray(tables.user.id, userIds));
}
