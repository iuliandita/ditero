import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeEach, expect, test } from "vitest";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString });
const zdb = zeroNodePg(schema, pool);

beforeEach(async () => {
	await resetAuthFixture(pool);
	await pool.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		select id,id,id||'@example.test',false,now(),now() from unnest(array['owner','viewer','outsider']) as id`);
	await pool.query(`insert into workspace (id,name,owner_id,kind) values
		('visible','Visible','owner','shared'), ('foreign','Foreign','outsider','shared')`);
	await pool.query(`insert into membership (id,user_id,workspace_id,role) values
		('owner-seat','owner','visible','owner'), ('viewer-seat','viewer','visible','viewer'),
		('outsider-seat','outsider','foreign','owner')`);
	await pool.query(`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values
		('visible-list','visible','owner','List','tasks','a0'),
		('foreign-list','foreign','outsider','List','tasks','a0')`);
	for (const scope of ["visible", "foreign"]) {
		for (const status of ["native", "pending", "blocked", "active"]) {
			const id = `${scope}-${status}`;
			await pool.query(
				"insert into task (id,list_id,title,sort_key) values ($1,$2,$1,$1)",
				[id, `${scope}-list`],
			);
			if (status === "native") continue;
			await pool.query(
				`insert into task_notification_activation
				(task_id,status,generation,owning_source_id,owning_owner_user_id,owning_job_id,
				import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
				values ($1,$2,1,'private-source','private-owner','private-job',$3,$3,$4)`,
				[
					id,
					status,
					status === "active" ? new Date("2026-08-01T00:00:00Z") : null,
					status === "active" ? "import" : null,
				],
			);
		}
	}
});

afterAll(async () => {
	await resetAuthFixture(pool);
	await pool.end();
});

async function visible(userId: string) {
	return (
		await zdb.run(
			queries.taskImportActivations.mine.fn({
				args: undefined,
				ctx: { id: userId },
			}),
		)
	).sort((a, b) => a.taskId.localeCompare(b.taskId));
}

test("owner and viewer see only task ID and status within their workspace", async () => {
	const expected = [
		{ taskId: "visible-active", status: "active" },
		{ taskId: "visible-blocked", status: "blocked" },
		{ taskId: "visible-pending", status: "pending" },
	];
	expect(await visible("owner")).toEqual(expected);
	expect(await visible("viewer")).toEqual(expected);
	expect(await visible("outsider")).toEqual(
		expected.map((row) => ({
			...row,
			taskId: row.taskId.replace("visible", "foreign"),
		})),
	);
});

test("revocation removes status visibility and an unknown user sees nothing", async () => {
	await pool.query("delete from membership where id='viewer-seat'");
	expect(await visible("viewer")).toEqual([]);
	expect(await visible("unknown")).toEqual([]);
});

test("the generated client schema excludes provenance and recipient evidence", () => {
	expect(
		Object.keys(schema.tables.taskNotificationActivation.columns).sort(),
	).toEqual(["status", "taskId"]);
	expect(Object.keys(schema.tables)).not.toContain("taskNotificationRecipient");
});
