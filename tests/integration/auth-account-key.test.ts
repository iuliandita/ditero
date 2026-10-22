import { randomBytes, randomUUID } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const oldEnv = {
	DATABASE_URL: databaseURL,
	GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const database = `account_key_${suffix}`;
const ownerRole = `account_key_owner_${suffix}`;
const runtimeRole = `account_key_runtime_${suffix}`;
const password = randomBytes(32).toString("hex");
const pools: Pool[] = [];
const roles: string[] = [];
let databaseCreated = false;
let owner: Pool;
let appPool: Pool | undefined;
let handleAuthRequest: typeof import("../../src/auth/auth.ts").handleAuthRequest;
let auth: typeof import("../../src/auth/auth.ts").auth;

const migrationsFolder = fileURLToPath(
	new URL("../../drizzle", import.meta.url),
);
const journal = JSON.parse(
	readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"),
) as { entries: { tag: string }[] };
const index = journal.entries.findIndex((entry) =>
	entry.tag.endsWith("_account_provider_unique"),
);

function connect(role: string) {
	const url = new URL(databaseURL as string);
	url.pathname = `/${database}`;
	url.username = role;
	url.password = password;
	const pool = new Pool({ connectionString: url.toString(), max: 4 });
	pools.push(pool);
	return pool;
}

function messages(error: unknown): string {
	const parts: string[] = [];
	for (let cause = error; cause instanceof Error; cause = cause.cause)
		parts.push(cause.message);
	return parts.join(" | ");
}

afterAll(async () => {
	for (const [key, value] of Object.entries(oldEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await appPool?.end();
	await Promise.all(pools.map((pool) => pool.end()));
	try {
		if (databaseCreated) await admin.query(`drop database "${database}"`);
		for (const role of roles) await admin.query(`drop role "${role}"`);
	} finally {
		await admin.end();
	}
});

beforeAll(async () => {
	expect(index).toBeGreaterThan(0);
	for (const role of [ownerRole, runtimeRole]) {
		await admin.query(
			`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
		);
		roles.push(role);
	}
	await admin.query(`create database "${database}" owner "${ownerRole}"`);
	databaseCreated = true;
	owner = connect(ownerRole);
});

async function seedUser(id: string) {
	await owner.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[id, "Linker", `${id}@example.test`],
	);
}

test("the migration refuses duplicate provider accounts, keeps every row, then adds the index", async () => {
	const baseline = mkdtempSync(join(tmpdir(), "ditero-account-key-"));
	try {
		mkdirSync(join(baseline, "meta"));
		const entries = journal.entries.slice(0, index);
		writeFileSync(
			join(baseline, "meta/_journal.json"),
			JSON.stringify({ ...journal, entries }),
		);
		for (const entry of entries)
			copyFileSync(
				join(migrationsFolder, `${entry.tag}.sql`),
				join(baseline, `${entry.tag}.sql`),
			);
		await migrate(drizzle(owner), { migrationsFolder: baseline });
	} finally {
		rmSync(baseline, { recursive: true, force: true });
	}
	const userId = `dup-${randomUUID()}`;
	await seedUser(userId);
	for (const id of ["dup-a", "dup-b"])
		await owner.query(
			"insert into account (id,account_id,provider_id,user_id,updated_at) values ($1,'g-dup','google',$2,now())",
			[id, userId],
		);

	const failure = await migrate(drizzle(owner), { migrationsFolder }).then(
		() => null,
		(error: unknown) => error,
	);
	expect(failure).not.toBeNull();
	expect(messages(failure)).toContain(
		"database-roles.md#better-auth-17-upgrade",
	);
	expect(
		(await owner.query("select id from account order by id")).rows,
	).toEqual([{ id: "dup-a" }, { id: "dup-b" }]);
	expect(
		(
			await owner.query(
				"select 1 from pg_indexes where indexname='account_provider_account_uidx'",
			)
		).rowCount,
	).toBe(0);

	await owner.query("delete from account where id='dup-b'");
	await migrate(drizzle(owner), { migrationsFolder });
	expect(
		(
			await owner.query(
				"select 1 from pg_indexes where indexname='account_provider_account_uidx'",
			)
		).rowCount,
	).toBe(1);
	await owner.query("delete from account");
	await owner.query('delete from "user"');
}, 120_000);

async function startAuth() {
	await owner.query(`grant usage on schema public to "${runtimeRole}"`);
	await owner.query(
		`grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
	);
	const runtimeURL = new URL(databaseURL as string);
	runtimeURL.pathname = `/${database}`;
	runtimeURL.username = runtimeRole;
	runtimeURL.password = password;
	process.env.DATABASE_URL = runtimeURL.toString();
	process.env.GOOGLE_CLIENT_ID = "test-id";
	process.env.GOOGLE_CLIENT_SECRET = "test-secret";
	({ auth, handleAuthRequest } = await import("../../src/auth/auth.ts"));
	({ pool: appPool } = await import("../../src/db/client.ts"));
}

function cookies(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

// Both flows read "no owner" before either inserts, which is the window the
// unique index has to close. The barrier holds each lookup until both arrived.
async function raceLink(subject: string) {
	const userId = `link-${randomUUID()}`;
	await seedUser(userId);
	const context = await auth.$context;
	const { internalAdapter } = context;
	const session = await internalAdapter.createSession(userId, false);
	const signed = `${session.token}.${await makeSignature(session.token, context.secret)}`;
	const sessionCookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
	vi.spyOn(context.socialProviders[0], "validateAuthorizationCode")
		.mockReset()
		.mockResolvedValue({
			accessToken: "test-token",
			idToken: await new SignJWT({
				sub: subject,
				email: `${userId}@example.test`,
				email_verified: true,
				name: "Linker",
			})
				.setProtectedHeader({ alg: "HS256" })
				.sign(new TextEncoder().encode("test-only-token-secret")),
		});
	const flows = await Promise.all(
		[1, 2].map(async () => {
			const start = await handleAuthRequest(
				new Request("http://localhost:3000/api/auth/link-social", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						cookie: sessionCookie,
					},
					body: JSON.stringify({ provider: "google", callbackURL: "/" }),
				}),
			);
			expect(start.status, await start.clone().text()).toBe(200);
			const state = new URL((await start.json()).url).searchParams.get("state");
			return { state, cookie: `${sessionCookie}; ${cookies(start)}` };
		}),
	);
	const original = internalAdapter.findAccountByKey.bind(internalAdapter);
	let arrived = 0;
	let release!: () => void;
	const both = new Promise<void>((resolve) => {
		release = resolve;
	});
	const barrier = vi
		.spyOn(internalAdapter, "findAccountByKey")
		.mockImplementation(async (key) => {
			const found = await original(key);
			if (++arrived === 2) release();
			await both;
			return found;
		});
	try {
		const responses = await Promise.all(
			flows.map(({ state, cookie }) =>
				handleAuthRequest(
					new Request(
						`http://localhost:3000/api/auth/callback/google?code=c&state=${state}`,
						{ headers: { cookie } },
					),
				),
			),
		);
		expect(arrived).toBe(2);
		return {
			responses,
			rows: (
				await owner.query(
					"select id from account where provider_id='google' and account_id=$1",
					[subject],
				)
			).rows,
		};
	} finally {
		barrier.mockRestore();
	}
}

test("concurrent links of one provider account leave one row and refuse the loser cleanly", async () => {
	await startAuth();
	const subject = `g-${randomUUID()}`;
	const { responses, rows } = await raceLink(subject);
	expect(rows).toHaveLength(1);
	expect(responses.map((response) => response.status).sort()).toEqual([
		302, 409,
	]);
	const refused = responses.find((response) => response.status === 409);
	expect(await refused?.json()).toMatchObject({
		code: "ACCOUNT_ALREADY_LINKED",
	});
}, 120_000);

test("control: without the index the same race stores two rows and breaks sign-in", async () => {
	await owner.query("drop index account_provider_account_uidx");
	const subject = `g-${randomUUID()}`;
	let rows: unknown[];
	try {
		const raced = await raceLink(subject);
		rows = raced.rows;
		expect(raced.responses.map((response) => response.status)).toEqual([
			302, 302,
		]);
		await expect(
			(await auth.$context).internalAdapter.findAccountOwnerByKey({
				providerId: "google",
				accountId: subject,
			}),
		).rejects.toThrow(/Multiple accounts/);
	} finally {
		await owner.query("delete from account where account_id=$1", [subject]);
		await owner.query(
			'create unique index "account_provider_account_uidx" on "account" using btree ("provider_id","account_id")',
		);
	}
	expect(rows).toHaveLength(2);
}, 120_000);
