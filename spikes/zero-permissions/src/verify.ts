// Spike A read-permission proof.
// Runs each synced query's ZQL server-side (exactly as the /query endpoint would)
// against the seeded Postgres, per user, and asserts what each user may see.
// No zero-cache needed: this tests the permission logic that gates all syncing.
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { queries } from "./zero/queries.ts";
import { schema } from "./zero/schema.gen.ts";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:pass@localhost:5432/ditero_spike",
});
const db = zeroNodePg(schema, pool);

const expected: Record<string, { lists: string[]; tasks: string[] }> = {
  u1: { lists: ["l_priv", "l_w1", "l_w2"], tasks: ["t_priv", "t_w1_a", "t_w1_b", "t_w2_a"] },
  u2: { lists: ["l_w1"], tasks: ["t_w1_a", "t_w1_b"] },
  u3: { lists: ["l_w2"], tasks: ["t_w2_a"] },
};

const sorted = (a: string[]) => [...a].sort();
const eq = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

const runIds = async (q: unknown) =>
  ((await db.run(q as never)) as { id: string }[]).map((r) => r.id);

let ok = true;
for (const uid of ["u1", "u2", "u3"]) {
  const lq = (queries.lists.mine as any).fn({ args: undefined, ctx: { id: uid } });
  const tq = (queries.tasks.mine as any).fn({ args: undefined, ctx: { id: uid } });
  const lists = await runIds(lq);
  const tasks = await runIds(tq);
  const pl = eq(lists, expected[uid].lists);
  const pt = eq(tasks, expected[uid].tasks);
  ok &&= pl && pt;
  console.log(`${uid} lists=${JSON.stringify(sorted(lists))} ${pl ? "OK" : "FAIL exp " + JSON.stringify(sorted(expected[uid].lists))}`);
  console.log(`${uid} tasks=${JSON.stringify(sorted(tasks))} ${pt ? "OK" : "FAIL exp " + JSON.stringify(sorted(expected[uid].tasks))}`);
}

// Negative: unauthenticated ctx must see nothing.
const anon = await runIds((queries.lists.mine as any).fn({ args: undefined, ctx: { id: "__nobody__" } }));
const anonOk = anon.length === 0;
ok &&= anonOk;
console.log(`anon lists=${JSON.stringify(anon)} ${anonOk ? "OK" : "FAIL should be empty"}`);

await pool.end();
console.log(ok ? "\nSPIKE-A READ MATRIX: PASS" : "\nSPIKE-A READ MATRIX: FAIL");
process.exit(ok ? 0 : 1);
