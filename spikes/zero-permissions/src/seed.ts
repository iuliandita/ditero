// Deterministic seed for the Spike A permission matrix.
//
// Users:   U1 Ana, U2 Bob, U3 Cy
// W-spaces: WP1 = Ana's personal | W1 = shared(Ana owner, Bob member) | W2 = shared(Cy owner, Ana viewer)
// Lists:    L_priv (WP1) | L_w1 (W1) | L_w2 (W2)
//
// Expected sync visibility:
//   Bob (U2)  -> L_w1 only. NOT L_w2, NOT L_priv.
//   Cy  (U3)  -> L_w2 only. NOT L_w1.
//   Ana (U1)  -> L_priv + L_w1 + L_w2 (viewer, read-only).
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as s from "./db/schema.ts";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:pass@localhost:5432/ditero_spike",
});
const db = drizzle(pool, { schema: s });

async function main() {
  // Idempotent: clear in FK-safe order.
  await db.delete(s.ackCapability);
  await db.delete(s.reminder);
  await db.delete(s.userChannel);
  await db.delete(s.task);
  await db.delete(s.list);
  await db.delete(s.membership);
  await db.delete(s.workspace);
  await db.delete(s.user);

  await db.insert(s.user).values([
    { id: "u1", name: "Ana", email: "ana@example.com" },
    { id: "u2", name: "Bob", email: "bob@example.com" },
    { id: "u3", name: "Cy", email: "cy@example.com" },
  ]);

  await db.insert(s.workspace).values([
    { id: "wp1", name: "Ana (personal)", ownerId: "u1", kind: "personal" },
    { id: "w1", name: "Household", ownerId: "u1", kind: "shared" },
    { id: "w2", name: "Cy Team", ownerId: "u3", kind: "shared" },
  ]);

  await db.insert(s.membership).values([
    { id: "m_wp1_u1", userId: "u1", workspaceId: "wp1", role: "owner" },
    { id: "m_w1_u1", userId: "u1", workspaceId: "w1", role: "owner" },
    { id: "m_w1_u2", userId: "u2", workspaceId: "w1", role: "member" },
    { id: "m_w2_u3", userId: "u3", workspaceId: "w2", role: "owner" },
    { id: "m_w2_u1", userId: "u1", workspaceId: "w2", role: "viewer" },
  ]);

  await db.insert(s.list).values([
    { id: "l_priv", workspaceId: "wp1", ownerId: "u1", title: "Ana secret" },
    { id: "l_w1", workspaceId: "w1", ownerId: "u1", title: "Groceries" },
    { id: "l_w2", workspaceId: "w2", ownerId: "u3", title: "Cy tasks" },
  ]);

  await db.insert(s.task).values([
    { id: "t_priv", listId: "l_priv", title: "Ana private task", done: false },
    { id: "t_w1_a", listId: "l_w1", title: "Buy milk", done: false },
    { id: "t_w1_b", listId: "l_w1", title: "Buy eggs", done: true },
    { id: "t_w2_a", listId: "l_w2", title: "Cy task", done: false },
  ]);

  console.log("seed: ok");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
