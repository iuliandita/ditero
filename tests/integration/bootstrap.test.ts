import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { ensurePersonalWorkspace } from "../../src/auth/bootstrap.ts";
import * as tables from "../../src/db/schema.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

beforeEach(async () => {
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
});

afterAll(async () => {
	await pool.end();
});

describe("ensurePersonalWorkspace", () => {
	test("is idempotent under concurrent repair", async () => {
		const person = {
			id: "repair-user",
			name: "Repair",
			email: "repair@test.invalid",
		};
		await db.insert(tables.user).values(person);

		await Promise.all([
			ensurePersonalWorkspace(person, db),
			ensurePersonalWorkspace(person, db),
			ensurePersonalWorkspace(person, db),
		]);

		const spaces = await db
			.select()
			.from(tables.workspace)
			.where(eq(tables.workspace.ownerId, person.id));
		expect(spaces).toHaveLength(1);
		expect(spaces[0].kind).toBe("personal");

		const memberships = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.userId, person.id));
		expect(memberships).toHaveLength(1);
		expect(memberships[0].role).toBe("owner");
	});

	test("rolls back the workspace when membership creation fails", async () => {
		const person = {
			id: "failing-user",
			name: "Fail",
			email: "fail@test.invalid",
		};
		await db.insert(tables.user).values(person);
		await db.execute(sql`
			create function fail_test_membership() returns trigger language plpgsql as $$
			begin
				if new.user_id = 'failing-user' then
					raise exception 'injected membership failure';
				end if;
				return new;
			end $$
		`);
		await db.execute(sql`
			create trigger fail_test_membership
			before insert on membership
			for each row execute function fail_test_membership()
		`);

		try {
			await expect(ensurePersonalWorkspace(person, db)).rejects.toThrow();
		} finally {
			await db.execute(sql`drop trigger fail_test_membership on membership`);
			await db.execute(sql`drop function fail_test_membership()`);
		}

		const spaces = await db
			.select()
			.from(tables.workspace)
			.where(eq(tables.workspace.ownerId, person.id));
		expect(spaces).toEqual([]);
	});
});
