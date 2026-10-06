import { randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { createManagedAccount } from "../../src/auth/managed-account.ts";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

test("real managed signup denies setup before the marker and cannot replace its reserved email", async () => {
	const admin = new Pool({ connectionString });
	const guardian = randomUUID();
	const shared = randomUUID();
	const role = `setup_race_${randomUUID().replaceAll("-", "")}`;
	const password = randomUUID();
	const url = new URL(connectionString);
	url.username = role;
	url.password = password;
	const runtime = new Pool({ connectionString: url.href });
	const zdb = zeroNodePg(schema, runtime);
	let kid: { id: string; email: string } | undefined;
	let roleCreated = false;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached!: () => void;
	const barrier = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let creation: ReturnType<typeof createManagedAccount> | undefined;
	const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
		.origin;
	const api = new Proxy(auth.api, {
		get(target, key, receiver) {
			if (key !== "signUpEmail") return Reflect.get(target, key, receiver);
			return async (input: Parameters<typeof auth.api.signUpEmail>[0]) => {
				const result = await auth.api.signUpEmail(input);
				kid = { id: result.user.id, email: result.user.email };
				reached();
				await held;
				return result;
			};
		},
	});
	async function counts(id: string) {
		return (
			await admin.query(
				`select
   (select count(*)::int from workspace where owner_id=$1) workspaces,
   (select count(*)::int from list where owner_id=$1) lists,
   (select count(*)::int from task join list on list.id=task.list_id where list.owner_id=$1) tasks,
   (select count(*)::int from dashboard where owner_id=$1) dashboards,
   (select count(*)::int from account_setup where id=$1) setup`,
				[id],
			)
		).rows[0];
	}
	async function denied(id: string) {
		const before = await counts(id);
		await expect(
			zdb.transaction((tx) =>
				withZeroUserContext(tx, id, () =>
					mutators.accountSetup.apply.fn({
						tx,
						ctx: { id },
						args: {
							requestId: randomUUID(),
							expectedRevision: 0,
							catalogVersion: 1,
							locale: "en",
							mode: "basic",
						},
					}),
				),
			),
		).rejects.toThrow("managed account");
		expect(await counts(id)).toEqual(before);
	}
	try {
		const statement = await admin.query(
			"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) statement",
			[role, password],
		);
		await admin.query(statement.rows[0].statement);
		roleCreated = true;
		await admin.query(`grant usage on schema public to "${role}"`);
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to "${role}"`,
		);
		expect(
			(
				await runtime.query(
					"select current_user,session_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
				)
			).rows,
		).toEqual([
			{
				current_user: role,
				session_user: role,
				rolsuper: false,
				rolbypassrls: false,
			},
		]);
		expect(
			(
				await runtime.query(
					"select relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) owner from pg_class where oid='account_setup'::regclass",
				)
			).rows,
		).toEqual([
			{
				relrowsecurity: true,
				relforcerowsecurity: true,
				owner: expect.not.stringMatching(`^${role}$`),
			},
		]);
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
			[guardian, "Race guardian", `${guardian}@setup.test`],
		);
		await admin.query(
			"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,'shared')",
			[shared, "Race shared", guardian],
		);
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
			[randomUUID(), guardian, shared],
		);
		creation = createManagedAccount(
			{
				guardianId: guardian,
				workspaceId: shared,
				displayName: "Race child",
				password,
			},
			drizzle(admin, { schema: tables }),
			{ api },
			{},
		);
		// A rejected real signup must fail the barrier rather than hang the test.
		await Promise.race([
			barrier,
			creation.then(() => {
				throw new Error("signup barrier was bypassed");
			}),
		]);
		if (!kid) throw new Error("signup did not produce an actor");
		const actor = kid;
		expect(
			(
				await admin.query("select id from managed_account where user_id=$1", [
					actor.id,
				])
			).rows,
		).toEqual([]);
		expect((await counts(actor.id)).workspaces).toBe(1);
		const signedIn = await auth.api.signInEmail({
			body: { email: actor.email, password },
			asResponse: true,
		});
		expect(signedIn.status).toBe(200);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		expect(cookie.length).toBeGreaterThan(0);
		const headers = new Headers({
			cookie,
			origin,
			"content-type": "application/json",
		});
		async function update(path: string, body: unknown) {
			return auth.handler(
				new Request(`${origin}/api/auth/${path}`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				}),
			);
		}
		expect((await auth.api.getSession({ headers }))?.user.id).toBe(actor.id);
		await denied(actor.id);
		const changeEmail = await update("change-email", {
			newEmail: `${randomUUID()}@setup.test`,
		});
		expect(changeEmail.status).toBe(400);
		expect(await changeEmail.json()).toMatchObject({
			code: "CHANGE_EMAIL_DISABLED",
		});
		const replaceEmail = await update("update-user", {
			email: `${randomUUID()}@setup.test`,
			name: "Rejected",
		});
		expect(replaceEmail.status).toBe(400);
		expect(await replaceEmail.json()).toMatchObject({
			code: "EMAIL_CAN_NOT_BE_UPDATED",
		});
		for (const email of ["", null, false]) {
			const response = await update("update-user", {
				email,
				name: "Still managed",
			});
			expect(response.status).toBe(200);
			expect(
				(
					await admin.query('select email,name from "user" where id=$1', [
						actor.id,
					])
				).rows,
			).toEqual([{ email: actor.email, name: "Still managed" }]);
			await denied(actor.id);
		}
		expect(
			(await update("update-user", { name: "Legitimate rename" })).status,
		).toBe(200);
		expect((await auth.api.getSession({ headers }))?.user.id).toBe(actor.id);
		release();
		expect(await creation).toEqual({ userId: actor.id, email: actor.email });
		expect(
			(
				await admin.query(
					"select restricted from managed_account where user_id=$1",
					[actor.id],
				)
			).rows,
		).toEqual([{ restricted: true }]);
		expect(
			(
				await admin.query(
					"select role from membership where user_id=$1 and workspace_id=$2",
					[actor.id, shared],
				)
			).rows,
		).toEqual([{ role: "member" }]);
		await admin.query(
			"update managed_account set restricted=false where user_id=$1",
			[actor.id],
		);
		await denied(actor.id);
	} finally {
		release();
		if (creation) await creation.catch(() => undefined);
		const ids = [guardian, ...(kid ? [kid.id] : [])];
		await runtime.end();
		await admin.query(
			"delete from managed_account where user_id=any($1::text[]) or guardian_id=any($1::text[])",
			[ids],
		);
		await admin.query(
			"delete from membership where workspace_id in (select id from workspace where owner_id=any($1::text[]))",
			[ids],
		);
		await admin.query("delete from workspace where owner_id=any($1::text[])", [
			ids,
		]);
		await admin.query('delete from "user" where id=any($1::text[])', [ids]);
		if (roleCreated) {
			await admin.query(`drop owned by "${role}"`);
			await admin.query(`drop role "${role}"`);
		}
		await admin.end();
	}
}, 30000);
