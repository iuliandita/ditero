// Spike A write-permission proof.
// Drives each mutator server-side through ZQLDatabase.transaction (same path
// handleMutateRequest uses), asserting allow/deny per caller role.
// Run after `bun run db:seed` for a deterministic starting state.
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { mutators } from "./zero/mutators.ts";
import { schema } from "./zero/schema.gen.ts";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:pass@localhost:5432/ditero_spike",
});
const db = zeroNodePg(schema, pool);

async function call(
  mutator: any,
  ctx: { id: string },
  args: unknown,
): Promise<{ ok: boolean; err?: string }> {
  try {
    await db.transaction(async (tx: any) => {
      await mutator.fn({ tx, ctx, args });
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, err: String(e?.message ?? e) };
  }
}

type Case = { name: string; expect: "allow" | "deny"; run: () => Promise<{ ok: boolean; err?: string }> };

const cases: Case[] = [
  {
    name: "u2 (member W1) edits W1 task",
    expect: "allow",
    run: () => call(mutators.task.update, { id: "u2" }, { id: "t_w1_a", done: true }),
  },
  {
    name: "u1 (viewer W2) edits W2 task",
    expect: "deny",
    run: () => call(mutators.task.update, { id: "u1" }, { id: "t_w2_a", done: true }),
  },
  {
    name: "u3 (non-member W1) edits W1 task",
    expect: "deny",
    run: () => call(mutators.task.update, { id: "u3" }, { id: "t_w1_a", done: true }),
  },
  {
    name: "u2 (member, not admin) sets role in W1",
    expect: "deny",
    run: () => call(mutators.membership.setRole, { id: "u2" }, { workspaceId: "w1", userId: "u1", role: "member" }),
  },
  {
    name: "u1 (owner W1) sets u2 role to viewer",
    expect: "allow",
    run: () => call(mutators.membership.setRole, { id: "u1" }, { workspaceId: "w1", userId: "u2", role: "viewer" }),
  },
];

let ok = true;
for (const c of cases) {
  const r = await c.run();
  const got = r.ok ? "allow" : "deny";
  const pass = got === c.expect;
  ok &&= pass;
  console.log(`[${pass ? "OK" : "FAIL"}] ${c.name} -> ${got}${r.err ? ` (${r.err})` : ""}`);
}

await pool.end();
console.log(ok ? "\nSPIKE-A WRITE MATRIX: PASS" : "\nSPIKE-A WRITE MATRIX: FAIL");
process.exit(ok ? 0 : 1);
