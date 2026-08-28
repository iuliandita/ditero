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
import { eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../src/db/schema.ts";
import type { Delivery, NtfyTap } from "../support/ntfy-tap.ts";

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
	spawnedAt: number | null;
	exit: { code: number | null; signal: NodeJS.Signals | null } | null;
	// Ring buffer, kept for the exit diagnostic: stderr is echoed as it arrives,
	// but a timeout needs it collated with the rest of the replica's state.
	stderr: string[];
};

const STDERR_KEEP = 12;

// How long a crash recovery can legitimately take, derived rather than picked:
// the reclaim cannot start before the lease expires (worker.ts), the reclaimed
// row then waits out one backoff step (2^attempts seconds plus up to 25%
// jitter, <= 2 attempts on any crash path here), and the reclaim, the re-claim
// and the send each cost a tick.
//
// SLOW is the runner allowance. #114's failures were all CPU starvation, and no
// budget is provably enough on a host whose speed is not controlled -- these
// waits assert that recovery HAPPENS, never how fast, since the product's claim
// is eventual at-least-once delivery.
const SLOW = 4;

export function recoveryBudgetMs(timing: RigTiming = RIG_TIMING): number {
	const backoffMs = 4_000 * 1.25;
	return Math.ceil(
		(timing.leaseMs +
			backoffMs +
			3 * timing.workerTickMs +
			timing.adapterDeadlineMs) *
			SLOW,
	);
}

export const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

export type WaitOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	// Appended to the timeout message. Runs ONLY after the deadline, so it can
	// be as expensive as it needs to be (#114: a rig timeout otherwise throws a
	// bare label, and the next occurrence is another round of inference over a
	// flake that does not reproduce locally).
	diagnose?: () => Promise<string>;
};

export async function waitFor(
	label: string,
	predicate: () => Promise<boolean>,
	options: number | WaitOptions = {},
): Promise<void> {
	const opts: WaitOptions =
		typeof options === "number" ? { timeoutMs: options } : options;
	const { timeoutMs = 30_000, intervalMs = 150, diagnose } = opts;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) {
			throw new Error(
				`rig: timed out waiting: ${label}${await explain(diagnose)}`,
			);
		}
		await sleep(intervalMs);
	}
}

// A broken diagnostic must never replace the timeout it exists to explain.
async function explain(diagnose?: () => Promise<string>): Promise<string> {
	if (!diagnose) return "";
	try {
		return `\n${await diagnose()}`;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `\n(diagnostic failed: ${reason})`;
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
			spawnedAt: null,
			exit: null,
			stderr: [],
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
		replica.spawnedAt = Date.now();
		replica.exit = null;
		replica.stderr = [];
		child.once("exit", (code, signal) => {
			replica.exited = true;
			replica.exit = { code, signal };
		});
		// Surfaced on failure only: a replica that refuses to boot otherwise
		// shows up as an opaque health-check timeout.
		const tag = `[${replica.id}]`;
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString().trim();
			if (!text) return;
			console.error(`${tag} ${text}`);
			replica.stderr.push(...text.split("\n"));
			if (replica.stderr.length > STDERR_KEEP) {
				replica.stderr.splice(0, replica.stderr.length - STDERR_KEEP);
			}
		});
	}

	// What a wait on this replica's lifecycle needs and the label cannot say.
	//
	// The armed suicide and any other exit are indistinguishable from `exited`
	// alone (#114), so an exit wait that expires has two candidates: the replica
	// never booted, or it booted fine and a starved runner never let it tick as
	// far as its crash point. The health probe separates them -- a replica that
	// answers /health as itself is up and merely slow.
	// Public: the crash-injection loop reports it when its retries are exhausted,
	// which is a path no `waitFor` diagnose callback covers (#186).
	async describeReplica(index: number): Promise<string> {
		const replica = this.replicas[index];
		const armed =
			parseEnv(this.extraEnv[index]).DITERO_TEST_CRASH_POINT ?? "(disarmed)";
		const age =
			replica.spawnedAt === null
				? "never spawned"
				: `${Date.now() - replica.spawnedAt}ms ago`;
		const exit = replica.exit
			? `code=${replica.exit.code} signal=${replica.exit.signal}`
			: "still running";
		const lines = [
			`  replica ${replica.id}: pid=${replica.process?.pid ?? "-"} spawned=${age} armed=${armed}`,
			`  exit: ${exit}`,
			`  health: ${await this.probeHealth(index)}`,
		];
		if (replica.stderr.length === 0) lines.push("  stderr: (silent)");
		else
			lines.push("  stderr:", ...replica.stderr.map((line) => `    ${line}`));
		return lines.join("\n");
	}

	private async probeHealth(index: number): Promise<string> {
		const replica = this.replicas[index];
		try {
			const response = await fetch(`http://localhost:${replica.port}/health`, {
				signal: AbortSignal.timeout(2_000),
			});
			const body = (await response.json()) as { replica?: string | null };
			return `:${replica.port} -> ${response.status}, replica=${body.replica ?? "unidentified"}`;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return `:${replica.port} unreachable (${reason})`;
		}
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
			{ timeoutMs, diagnose: () => this.describeReplica(index) },
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

export type ReminderAnchor = { dueAt: Date; reminderTime: string };

// The dueAt/reminderTime pair for a reminder `minutesAgo` in the past, both
// derived from ONE instant.
//
// That is the whole point of returning them together (#95). A non-recurring
// task's occurrence is dueAt's CALENDAR DATE re-timed by reminderTime
// (reminder-window.ts), so an "HH:MM" taken from `now - minutesAgo` against a
// dueAt of `now` describes a different instant entirely whenever the two fall
// on different UTC dates: just after midnight, "30 minutes ago" expands to
// 23:40 TODAY, ~23.5h in the future, outside [now - grace, now), and no
// reminder is ever created.
export function reminderAnchor(
	minutesAgo: number,
	now: Date = new Date(),
): ReminderAnchor {
	const at = new Date(now.getTime() - minutesAgo * 60_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		dueAt: at,
		reminderTime: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
	};
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
	const anchor = reminderAnchor(fields.minutesAgo ?? 2);
	await database.insert(tables.task).values({
		id,
		listId: scope.listId,
		title: id,
		sortKey: "a0",
		dueAt: anchor.dueAt,
		reminderTime: anchor.reminderTime,
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

// Reminder deliveries the tap actually received for a task. The ntfy title is
// the task title, and the fixture titles every task with its own id.
//
// The ackUrl is what separates a reminder from an event notification: dispatch
// mints a capability only for rows carrying a reminder_state. Without that
// filter the overdue sweep -- which every replica runs once at boot -- lands in
// these counts. `topic` narrows to one recipient's channel.
export function wireFor(
	tap: NtfyTap,
	taskId: string,
	topic?: string,
): Delivery[] {
	return tap.deliveries.filter(
		(delivery) =>
			delivery.title === taskId &&
			delivery.ackUrl !== null &&
			(topic === undefined || delivery.topic === topic),
	);
}

// The outbox rows behind a set of tasks. One projection for both rig suites:
// the columns are cheap and which subset a given assertion reads is not worth
// a second variant.
export async function outboxFor(database: Database, taskIds: string[]) {
	return await database
		.select({
			id: tables.notificationOutbox.id,
			key: tables.notificationOutbox.idempotencyKey,
			status: tables.notificationOutbox.status,
			attempts: tables.notificationOutbox.attempts,
			claimedBy: tables.notificationOutbox.claimedBy,
			recipientUserId: tables.notificationOutbox.recipientUserId,
		})
		.from(tables.notificationOutbox)
		.innerJoin(
			tables.reminderState,
			eq(tables.notificationOutbox.reminderStateId, tables.reminderState.id),
		)
		.where(inArray(tables.reminderState.taskId, taskIds));
}

// Everything the notification pipeline durably knows about a set of tasks, as
// one block of text for a `waitFor` timeout.
//
// The three columns that discriminate the ways a rig wait can hang are the
// reason this exists: an outbox row still holding `claimed_by` past its lease
// means the reclaim never ran; climbing `attempts` with delivery_attempt rows
// carrying a retry class means the re-send ran and failed; `status=sent` with
// no matching delivery means it reached the provider and not the tap. A bare
// label distinguishes none of those.
export async function describePipeline(
	database: Database,
	taskIds: string[],
): Promise<string> {
	const reminders = await database
		.select({
			id: tables.reminderState.id,
			taskId: tables.reminderState.taskId,
			recipient: tables.reminderState.recipientUserId,
			status: tables.reminderState.status,
			fireCount: tables.reminderState.fireCount,
			nextAttemptAt: tables.reminderState.nextAttemptAt,
			deferredUntil: tables.reminderState.deferredUntil,
			firedLate: tables.reminderState.firedLate,
		})
		.from(tables.reminderState)
		.where(inArray(tables.reminderState.taskId, taskIds));

	const outbox = await database
		.select({
			id: tables.notificationOutbox.id,
			key: tables.notificationOutbox.idempotencyKey,
			status: tables.notificationOutbox.status,
			attempts: tables.notificationOutbox.attempts,
			claimedBy: tables.notificationOutbox.claimedBy,
			claimedAt: tables.notificationOutbox.claimedAt,
			nextAttemptAt: tables.notificationOutbox.nextAttemptAt,
		})
		.from(tables.notificationOutbox)
		.innerJoin(
			tables.reminderState,
			eq(tables.notificationOutbox.reminderStateId, tables.reminderState.id),
		)
		.where(inArray(tables.reminderState.taskId, taskIds));

	const attempts = outbox.length
		? await database
				.select({
					outboxId: tables.deliveryAttempt.outboxId,
					attemptNo: tables.deliveryAttempt.attemptNo,
					retryClass: tables.deliveryAttempt.retryClass,
					providerStatus: tables.deliveryAttempt.providerStatus,
					error: tables.deliveryAttempt.error,
					createdAt: tables.deliveryAttempt.createdAt,
				})
				.from(tables.deliveryAttempt)
				.where(
					inArray(
						tables.deliveryAttempt.outboxId,
						outbox.map((row) => row.id),
					),
				)
		: [];

	// Outbox rows for the same tasks that carry NO reminder_state: overdue and
	// other event notifications. The join above cannot reach them, and they ride
	// in the same claimed batch as the reminder, so a crash can fire on one of
	// them and leave the reminder row looking inexplicably stranded (#186).
	const events = (
		await database.execute<{
			key: string;
			status: string;
			attempts: number;
			claimed_by: string | null;
		}>(sql`
			select idempotency_key as key, status, attempts, claimed_by
			from notification_outbox
			where reminder_state_id is null
				and payload->>'taskId' in ${taskIds}
		`)
	).rows;

	const lines = [
		`rig state at ${new Date().toISOString()} for ${taskIds.join(", ")}`,
	];
	lines.push(`  reminder_state (${reminders.length}):`);
	for (const row of reminders) {
		lines.push(
			`    ${row.taskId} -> ${row.recipient} status=${row.status} fireCount=${row.fireCount}` +
				` late=${row.firedLate} next=${iso(row.nextAttemptAt)} deferred=${iso(row.deferredUntil)}`,
		);
	}
	lines.push(`  notification_outbox (${outbox.length}):`);
	for (const row of outbox) {
		lines.push(
			`    ${row.key} status=${row.status} attempts=${row.attempts}` +
				` claimedBy=${row.claimedBy ?? "-"} claimedAt=${iso(row.claimedAt)} next=${iso(row.nextAttemptAt)}`,
		);
		for (const attempt of attempts.filter((a) => a.outboxId === row.id)) {
			lines.push(
				`      attempt#${attempt.attemptNo} ${attempt.retryClass}` +
					` provider=${attempt.providerStatus ?? "-"} at=${iso(attempt.createdAt)}` +
					` error=${attempt.error ?? "-"}`,
			);
		}
	}
	lines.push(`  event outbox, no reminder_state (${events.length}):`);
	for (const row of events) {
		lines.push(
			`    ${row.key} status=${row.status} attempts=${row.attempts}` +
				` claimedBy=${row.claimed_by ?? "-"}`,
		);
	}
	return lines.join("\n");
}

const iso = (value: Date | null) => value?.toISOString() ?? "-";

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
