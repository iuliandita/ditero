// Reminder scheduler + escalation + ack. Single-leader via Postgres advisory lock
// (so multiple backend replicas don't double-fire). Reminder state is
// backend-owned (drizzle); task.done acks go through the Zero mutator (the seam).
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, pool } from "../db/client.ts";
import * as s from "../db/schema.ts";
import { mutators } from "../zero/mutators.ts";
import { schema as zeroSchema } from "../zero/schema.gen.ts";
import { sendNtfy } from "./ntfy.ts";
import { sendTelegram } from "./telegram.ts";

const zdb = zeroNodePg(zeroSchema, pool);
const LOCK_KEY = 918273; // arbitrary advisory-lock id for the reminder scheduler
const ackBase = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 3000}`;

async function dispatch(userId: string, title: string, message: string, ackUrl: string): Promise<number> {
  const chans = await db.select().from(s.userChannel).where(eq(s.userChannel.userId, userId));
  for (const c of chans) {
    if (c.kind === "ntfy") await sendNtfy({ topic: c.target, title, message, ackUrl, tags: ["bell"] });
    else if (c.kind === "telegram") await sendTelegram({ chatId: c.target, text: `${title}\n${message}`, ackUrl });
  }
  return chans.length;
}

export async function tick(now = new Date()): Promise<{ fired: string[]; escalated: string[] }> {
  const fired: string[] = [];
  const escalated: string[] = [];

  const lock = await db.execute(sql`select pg_try_advisory_lock(${LOCK_KEY}) as ok`);
  if (!(lock.rows[0] as { ok: boolean }).ok) return { fired, escalated }; // another leader holds it
  try {
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

    for (const r of due) {
      const ready =
        !r.lastFiredAt || (now.getTime() - new Date(r.lastFiredAt).getTime()) / 1000 >= r.intervalSec;
      if (!ready) continue;
      const task = (await db.select().from(s.task).where(eq(s.task.id, r.taskId)))[0];
      const label = task?.title ?? r.taskId;

      if (r.repeatCount < r.maxRepeats) {
        await dispatch(
          r.userId,
          "Reminder",
          `${label} (try ${r.repeatCount + 1}/${r.maxRepeats})`,
          `${ackBase}/ack/${r.id}?user=${r.userId}`,
        );
        await db
          .update(s.reminder)
          .set({ state: "fired", repeatCount: r.repeatCount + 1, lastFiredAt: now })
          .where(eq(s.reminder.id, r.id));
        fired.push(r.id);
      } else if (r.fallbackUserId && r.state !== "escalated") {
        await dispatch(
          r.fallbackUserId,
          "Escalation",
          `Unacked: ${label}`,
          `${ackBase}/ack/${r.id}?user=${r.fallbackUserId}`,
        );
        await db.update(s.reminder).set({ state: "escalated" }).where(eq(s.reminder.id, r.id));
        escalated.push(r.id);
      }
    }
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${LOCK_KEY})`);
  }
  return { fired, escalated };
}

// The seam: backend marks the reminder acked; task.done is set through the SAME
// Zero mutator zero-cache would run, so subscribed clients update live.
export async function ackReminder(reminderId: string, byUserId: string): Promise<void> {
  const r = (await db.select().from(s.reminder).where(eq(s.reminder.id, reminderId)))[0];
  if (!r) throw new Error("reminder not found");
  await db
    .update(s.reminder)
    .set({ state: "acked", ackedBy: byUserId, ackedAt: new Date() })
    .where(eq(s.reminder.id, reminderId));
  await zdb.transaction(async (tx: any) => {
    await (mutators.task.update as any).fn({ tx, ctx: { id: byUserId }, args: { id: r.taskId, done: true } });
  });
}
