import { createHash, randomBytes } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Pool } from "pg";
import { db, pool } from "../db/client.ts";
import * as s from "../db/schema.ts";
import { mutators } from "../zero/mutators.ts";
import { schema as zeroSchema } from "../zero/schema.gen.ts";
import { sendNtfy } from "./ntfy.ts";
import { sendTelegram } from "./telegram.ts";

const zdb = zeroNodePg(zeroSchema, pool);
const LOCK_KEY = 918273;
const ackBase =
  process.env.PUBLIC_BASE_URL ??
  `http://localhost:${process.env.API_PORT ?? 3000}`;

type LockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export async function withSchedulerLock<T>(
  work: () => Promise<T>,
  schedulerPool: Pool = pool,
): Promise<LockResult<T>> {
  const client = await schedulerPool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock($1) as ok",
      [LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await work() };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueAckCapability(
  reminderId: string,
  userId: string,
  options: { expiresAt?: Date; now?: Date } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx
      .update(s.ackCapability)
      .set({ consumedAt: now })
      .where(
        and(
          eq(s.ackCapability.reminderId, reminderId),
          eq(s.ackCapability.userId, userId),
          eq(s.ackCapability.action, "complete"),
          isNull(s.ackCapability.consumedAt),
        ),
      );
    await tx.insert(s.ackCapability).values({
      id: crypto.randomUUID(),
      reminderId,
      userId,
      action: "complete",
      tokenHash: hashToken(token),
      expiresAt:
        options.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });
  });
  return token;
}

async function dispatch(
  userId: string,
  title: string,
  message: string,
  ackUrl: string,
): Promise<number> {
  const channels = await db
    .select()
    .from(s.userChannel)
    .where(eq(s.userChannel.userId, userId));
  for (const channel of channels) {
    if (channel.kind === "ntfy") {
      await sendNtfy({
        topic: channel.target,
        title,
        message,
        ackUrl,
        tags: ["bell"],
      });
    } else if (channel.kind === "telegram") {
      await sendTelegram({
        chatId: channel.target,
        text: `${title}\n${message}`,
        ackUrl,
      });
    }
  }
  return channels.length;
}

async function notify(
  reminderId: string,
  userId: string,
  title: string,
  message: string,
): Promise<number> {
  const token = await issueAckCapability(reminderId, userId);
  return dispatch(userId, title, message, `${ackBase}/ack/${token}`);
}

async function tickAsLeader(now: Date) {
  const fired: string[] = [];
  const escalated: string[] = [];
  const due = await db
    .select()
    .from(s.reminder)
    .where(
      and(
        isNull(s.reminder.ackedAt),
        lte(s.reminder.fireAt, now),
        or(eq(s.reminder.state, "pending"), eq(s.reminder.state, "fired")),
      ),
    );

  for (const reminder of due) {
    const ready =
      !reminder.lastFiredAt ||
      (now.getTime() - new Date(reminder.lastFiredAt).getTime()) / 1000 >=
        reminder.intervalSec;
    if (!ready) continue;
    const [task] = await db
      .select()
      .from(s.task)
      .where(eq(s.task.id, reminder.taskId));
    const label = task?.title ?? reminder.taskId;

    if (reminder.repeatCount < reminder.maxRepeats) {
      await notify(
        reminder.id,
        reminder.userId,
        "Reminder",
        `${label} (try ${reminder.repeatCount + 1}/${reminder.maxRepeats})`,
      );
      await db
        .update(s.reminder)
        .set({
          state: "fired",
          repeatCount: reminder.repeatCount + 1,
          lastFiredAt: now,
        })
        .where(eq(s.reminder.id, reminder.id));
      fired.push(reminder.id);
    } else if (reminder.fallbackUserId && reminder.state !== "escalated") {
      await notify(
        reminder.id,
        reminder.fallbackUserId,
        "Escalation",
        `Unacked: ${label}`,
      );
      await db
        .update(s.reminder)
        .set({ state: "escalated" })
        .where(eq(s.reminder.id, reminder.id));
      escalated.push(reminder.id);
    }
  }
  return { fired, escalated };
}

export async function tick(
  now = new Date(),
): Promise<{ fired: string[]; escalated: string[] }> {
  const result = await withSchedulerLock(() => tickAsLeader(now));
  return result.acquired ? result.value : { fired: [], escalated: [] };
}

export async function ackReminderWithToken(
  token: string,
  now = new Date(),
): Promise<void> {
  await zdb.transaction(async (tx: any) => {
    const client = tx.dbTransaction.wrappedTransaction;
    const capability = await client.query(
      `update ack_capability
       set consumed_at = $2
       where token_hash = $1 and consumed_at is null and expires_at > $2
       returning reminder_id, user_id, action`,
      [hashToken(token), now],
    );
    const grant = capability.rows[0] as
      | { reminder_id: string; user_id: string; action: string }
      | undefined;
    if (!grant || grant.action !== "complete") {
      throw new Error("invalid or expired acknowledgement capability");
    }

    const reminder = await client.query(
      "select task_id from reminder where id = $1 for update",
      [grant.reminder_id],
    );
    const taskId = (reminder.rows[0] as { task_id: string } | undefined)?.task_id;
    if (!taskId) throw new Error("reminder not found");

    await client.query(
      `update reminder
       set state = 'acked', acked_by = $2, acked_at = $3
       where id = $1`,
      [grant.reminder_id, grant.user_id, now],
    );
    await (mutators.task.update as any).fn({
      tx,
      ctx: { id: grant.user_id },
      args: { id: taskId, done: true },
    });
  });
}
