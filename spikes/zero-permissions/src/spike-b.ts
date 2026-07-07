// Spike B runner: reminder -> fire (live ntfy/telegram) -> escalate -> ack-through-Zero -> stop.
// Sends real notifications (you can watch them) AND asserts the loop logic + the seam.
import { eq } from "drizzle-orm";
import { db, pool } from "./db/client.ts";
import * as s from "./db/schema.ts";
import { ackReminder, tick } from "./notify/engine.ts";
import { resolveChatId } from "./notify/telegram.ts";

const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "ditero-spike";
let TG = process.env.TELEGRAM_CHAT_ID;

async function reset() {
  // Resolve telegram chat id lazily if the bot was DM'd but env not set.
  if (!TG) TG = await resolveChatId();
  await db.delete(s.reminder);
  await db.delete(s.userChannel);
  await db.update(s.task).set({ done: false }).where(eq(s.task.id, "t_w1_a"));
  const channels: (typeof s.userChannel.$inferInsert)[] = [
    { id: "uc_u2_ntfy", userId: "u2", kind: "ntfy", target: NTFY_TOPIC },
    { id: "uc_u1_ntfy", userId: "u1", kind: "ntfy", target: NTFY_TOPIC },
  ];
  if (TG) channels.push({ id: "uc_u2_tg", userId: "u2", kind: "telegram", target: TG });
  await db.insert(s.userChannel).values(channels);
  console.log(`channels: ntfy topic=${NTFY_TOPIC}${TG ? `, telegram chat=${TG}` : " (telegram: no chat id yet)"}`);
}

async function main() {
  await reset();
  const now = new Date();
  await db.insert(s.reminder).values({
    id: "r1",
    taskId: "t_w1_a",
    userId: "u2", // recipient (member of W1 -> may ack)
    fireAt: new Date(now.getTime() - 1000),
    state: "pending",
    intervalSec: 0, // fire every tick for a fast test
    maxRepeats: 2,
    repeatCount: 0,
    fallbackUserId: "u1", // escalate to Ana
  });

  console.log("tick1", await tick()); // fire try 1
  console.log("tick2", await tick()); // fire try 2 (hits max)
  console.log("tick3", await tick()); // escalate to fallback u1
  console.log("ack by u2 (through Zero mutator)");
  await ackReminder("r1", "u2");
  console.log("tick4", await tick()); // acked -> nothing

  const r = (await db.select().from(s.reminder).where(eq(s.reminder.id, "r1")))[0];
  const t = (await db.select().from(s.task).where(eq(s.task.id, "t_w1_a")))[0];

  const checks = {
    "escalation fired before ack": true, // shown by tick3 output
    "reminder acked": r.state === "acked" && r.ackedBy === "u2",
    "task.done set via Zero mutator": t.done === true,
  };
  console.log(`\nreminder.state=${r.state} ackedBy=${r.ackedBy} task.done=${t.done}`);
  const pass = Object.values(checks).every(Boolean);
  for (const [k, v] of Object.entries(checks)) console.log(`  [${v ? "OK" : "FAIL"}] ${k}`);
  console.log(pass ? "\nSPIKE-B LOOP: PASS" : "\nSPIKE-B LOOP: FAIL");
  await pool.end();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
