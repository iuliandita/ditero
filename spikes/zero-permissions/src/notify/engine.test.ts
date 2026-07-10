import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { db } from "../db/client.ts";
import * as s from "../db/schema.ts";
import {
  ackReminderWithToken,
  issueAckCapability,
  withSchedulerLock,
} from "./engine.ts";

beforeEach(async () => {
  await db.delete(s.ackCapability);
  await db.delete(s.reminder);
  await db.delete(s.userChannel);
  await db.delete(s.task);
  await db.delete(s.list);
  await db.delete(s.membership);
  await db.delete(s.workspace);
  await db.delete(s.user);

  await db.insert(s.user).values([
    { id: "u1", name: "Ana", email: "ana@test.invalid" },
    { id: "u2", name: "Bob", email: "bob@test.invalid" },
    { id: "u3", name: "Cy", email: "cy@test.invalid" },
  ]);
  await db.insert(s.workspace).values({
    id: "w1",
    name: "Household",
    ownerId: "u1",
    kind: "shared",
  });
  await db.insert(s.membership).values([
    { id: "m1", userId: "u1", workspaceId: "w1", role: "owner" },
    { id: "m2", userId: "u2", workspaceId: "w1", role: "member" },
  ]);
  await db.insert(s.list).values({
    id: "l1",
    workspaceId: "w1",
    ownerId: "u1",
    title: "Shared",
  });
  await db.insert(s.task).values({
    id: "t1",
    listId: "l1",
    title: "Test task",
    done: false,
  });
  await db.insert(s.reminder).values({
    id: "r1",
    taskId: "t1",
    userId: "u2",
    fireAt: new Date(0),
  });
});

describe("scheduler advisory lock", () => {
  test("admits one runner and releases leadership", async () => {
    let enterFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSchedulerLock(async () => {
      enterFirst?.();
      await held;
    });
    await entered;

    const second = await withSchedulerLock(async () => undefined);
    expect(second.acquired).toBe(false);

    releaseFirst?.();
    await first;
    expect((await withSchedulerLock(async () => undefined)).acquired).toBe(true);
  });
});

describe("ack capabilities", () => {
  test("stores a hash and consumes a valid token once", async () => {
    const token = await issueAckCapability("r1", "u2");
    const [stored] = await db.select().from(s.ackCapability);
    expect(stored.tokenHash).not.toBe(token);

    await ackReminderWithToken(token);
    const [reminder] = await db
      .select()
      .from(s.reminder)
      .where(eq(s.reminder.id, "r1"));
    const [task] = await db.select().from(s.task).where(eq(s.task.id, "t1"));
    expect(reminder.state).toBe("acked");
    expect(reminder.ackedBy).toBe("u2");
    expect(task.done).toBe(true);
    await expect(ackReminderWithToken(token)).rejects.toThrow(/invalid or expired/i);
  });

  test("rejects invalid and expired tokens", async () => {
    await expect(ackReminderWithToken("invalid")).rejects.toThrow(
      /invalid or expired/i,
    );
    const token = await issueAckCapability("r1", "u2", {
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(ackReminderWithToken(token)).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  test("rolls back consumption when the bound recipient lacks access", async () => {
    const token = await issueAckCapability("r1", "u3");
    await expect(ackReminderWithToken(token)).rejects.toThrow(/access denied/i);
    const [capability] = await db.select().from(s.ackCapability);
    expect(capability.consumedAt).toBeNull();
    const [reminder] = await db.select().from(s.reminder);
    expect(reminder.state).toBe("pending");
  });
});
