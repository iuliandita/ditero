import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { DEFAULT_APPEARANCE } from "../../src/domain/appearance.ts";
import { BUILTIN_THEME_DOCUMENTS } from "../../src/domain/theme-document.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const zdb = zeroNodePg(schema, runtime);
const role = "ditero_theme_sync_test";
async function set(
	actor: string,
	args: Parameters<typeof mutators.userPref.set.fn>[0]["args"],
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, actor, () =>
			mutators.userPref.set.fn({ tx, ctx: { id: actor }, args }),
		),
	);
}
beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname='${role}') then create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => {
		void client.query(`set role ${role}`);
	});
	const restricted = await runtime.query(
		"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(restricted.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user" (id,name,email,email_verified) values ('alice','Alice','alice@example.test',false),('bob','Bob','bob@example.test',false)`,
	);
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});
test("real preference mutation derives ownership from trusted context and preserves mode", async () => {
	await set("bob", {
		theme: "dark",
		appearance: { ...DEFAULT_APPEARANCE, selected: "slate" },
	});
	await set("alice", {
		theme: "light",
		appearance: { ...DEFAULT_APPEARANCE, selected: "paper" },
		id: "bob",
	} as Parameters<typeof set>[1]);
	await set("alice", {
		appearance: { ...DEFAULT_APPEARANCE, accentTheme: "blue" },
	});
	const rows = await admin.query(
		"select id,theme,appearance from user_pref order by id",
	);
	expect(rows.rows).toEqual([
		{
			id: "alice",
			theme: "light",
			appearance: { ...DEFAULT_APPEARANCE, accentTheme: "blue" },
		},
		{
			id: "bob",
			theme: "dark",
			appearance: { ...DEFAULT_APPEARANCE, selected: "slate" },
		},
	]);
	await expect(
		set("missing", { appearance: DEFAULT_APPEARANCE }),
	).rejects.toThrow();
	expect(
		(await admin.query("select count(*)::int as count from user_pref")).rows[0]
			.count,
	).toBe(2);
});
test("actual server mutator rejects malformed, unsafe, oversized and prototype-shaped JSON without replacing valid data", async () => {
	await set("alice", { appearance: DEFAULT_APPEARANCE });
	const custom = {
		...DEFAULT_APPEARANCE,
		selected: "mine",
		documents: [
			{ id: "mine", document: structuredClone(BUILTIN_THEME_DOCUMENTS.paper) },
		],
	};
	for (const bad of [
		{ ...DEFAULT_APPEARANCE, css: "url(https://example.test)" },
		{ ...DEFAULT_APPEARANCE, selected: "missing" },
		{
			...custom,
			documents: Array.from({ length: 21 }, (_, i) => ({
				...custom.documents[0],
				id: `t${i}`,
			})),
		},
		JSON.parse(
			`${JSON.stringify(DEFAULT_APPEARANCE).slice(0, -1)},"__proto__":{}}`,
		),
		{
			...custom,
			documents: [
				{
					id: "mine",
					document: {
						...custom.documents[0].document,
						name: "x".repeat(350001),
					},
				},
			],
		},
		{
			...custom,
			documents: [
				{
					id: "mine",
					document: {
						...custom.documents[0].document,
						light: {
							...custom.documents[0].document.light,
							foreground: "#faf7f0",
						},
					},
				},
			],
		},
	]) {
		await expect(
			set("alice", { appearance: bad } as Parameters<typeof set>[1]),
		).rejects.toThrow();
		expect(
			(await admin.query("select appearance from user_pref where id='alice'"))
				.rows[0].appearance,
		).toEqual(DEFAULT_APPEARANCE);
	}
	await set("alice", { appearance: custom });
	expect(
		(await admin.query("select appearance from user_pref where id='alice'"))
			.rows[0].appearance,
	).toEqual(custom);
});
