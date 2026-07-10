import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);
const listsMine = queries.lists.mine;

const users = ["owner", "admin", "member", "viewer", "outsider"] as const;

beforeAll(async () => {
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.user);

	await db.insert(tables.user).values(
		users.map((id) => ({
			id,
			name: id,
			email: `${id}@test.invalid`,
		})),
	);
	await db.insert(tables.workspace).values({
		id: "shared",
		name: "Shared",
		ownerId: "owner",
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		(["owner", "admin", "member", "viewer"] as const).map((role) => ({
			id: `membership-${role}`,
			userId: role,
			workspaceId: "shared",
			role,
		})),
	);
	await db.insert(tables.list).values({
		id: "shared-list",
		workspaceId: "shared",
		ownerId: "owner",
		title: "Shared list",
	});
});

afterAll(async () => {
	await pool.end();
});

describe("workspace membership permissions", () => {
	test("list schema has no list-level access primitive", () => {
		expect(schema.tables.list.columns).not.toHaveProperty("visibility");
	});

	test.each([
		"owner",
		"admin",
		"member",
		"viewer",
	] as const)("%s can read workspace lists", async (userId) => {
		const query = listsMine.fn({
			args: undefined,
			ctx: { id: userId },
		});
		const rows = await zdb.run(query);
		expect(rows.map((row) => row.id)).toContain("shared-list");
	});

	test("non-members cannot read workspace lists", async () => {
		const query = listsMine.fn({
			args: undefined,
			ctx: { id: "outsider" },
		});
		expect(await zdb.run(query)).toEqual([]);
	});

	test.each([
		"owner",
		"admin",
		"member",
	] as const)("%s can create workspace content", async (userId) => {
		await zdb.transaction(async (tx) => {
			await mutators.list.create.fn({
				tx,
				ctx: { id: userId },
				args: {
					id: `created-${userId}`,
					workspaceId: "shared",
					title: userId,
				},
			});
		});
	});

	test.each([
		"viewer",
		"outsider",
	] as const)("%s cannot create workspace content", async (userId) => {
		await expect(
			zdb.transaction(async (tx) => {
				await mutators.list.create.fn({
					tx,
					ctx: { id: userId },
					args: {
						id: `denied-${userId}`,
						workspaceId: "shared",
						title: userId,
					},
				});
			}),
		).rejects.toThrow(/access denied/);
	});
});
