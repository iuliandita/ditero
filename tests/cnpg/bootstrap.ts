import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const image =
	"postgres:18@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20";
const name = `ditero-cnpg-bootstrap-${randomUUID()}`;
const password = randomUUID();
function docker(args: string[], env?: Record<string, string>) {
	const result = Bun.spawnSync(["docker", ...args], {
		env: { ...process.env, ...env },
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}
let pool: Pool | undefined;
let started = false;
try {
	docker(
		[
			"run",
			"--detach",
			"--name",
			name,
			"--publish",
			"127.0.0.1::5432",
			"--tmpfs",
			"/var/lib/postgresql:rw,size=512m",
			"--env",
			"POSTGRES_PASSWORD",
			"--env",
			"POSTGRES_DB=ditero",
			image,
			"postgres",
			"-c",
			"wal_level=logical",
		],
		{ POSTGRES_PASSWORD: password },
	);
	started = true;
	const inspected = JSON.parse(docker(["inspect", name])) as {
		NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
	}[];
	const port = Number(
		inspected[0].NetworkSettings.Ports["5432/tcp"][0].HostPort,
	);
	pool = new Pool({
		host: "127.0.0.1",
		port,
		user: "postgres",
		password,
		database: "ditero",
		connectionTimeoutMillis: 1000,
	});
	let ready = false;
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			await pool.query("select 1");
			ready = true;
			break;
		} catch {
			await Bun.sleep(500);
		}
	}
	assert.ok(ready, "Owned PostgreSQL fixture did not become ready");
	await pool.query(
		"create role ditero_migrator login nosuperuser nocreatedb nocreaterole noinherit nobypassrls; alter database ditero owner to ditero_migrator",
	);
	await pool.query(
		await readFile(
			new URL("../../deploy/kustomize/cnpg/roles.sql", import.meta.url),
			"utf8",
		),
	);
	const statement = await pool.query<{ statement: string }>(
		"select format('alter role ditero_migrator password %L', $1::text) as statement",
		[password],
	);
	await pool.query(statement.rows[0].statement);
	const runtimePassword = await pool.query<{ statement: string }>(
		"select format('alter role ditero_runtime login password %L', $1::text) as statement",
		[password],
	);
	await pool.query(runtimePassword.rows[0].statement);
	const databaseUrl = new URL(
		`postgres://ditero_migrator@127.0.0.1:${port}/ditero`,
	);
	databaseUrl.password = password;
	const migration = Bun.spawn(["bun", "run", "db:migrate"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: { ...process.env, DATABASE_URL: databaseUrl.href, NODE_ENV: "test" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stderr] = await Promise.all([
		migration.exited,
		new Response(migration.stderr).text(),
		new Response(migration.stdout).text(),
	]);
	assert.equal(exit, 0, stderr);
	const roles = await pool.query<{
		rolname: string;
		rolsuper: boolean;
		rolbypassrls: boolean;
	}>(
		"select rolname,rolsuper,rolbypassrls from pg_roles where rolname in ('ditero_runtime','ditero_migrator','ditero_zero') order by rolname",
	);
	assert.deepEqual(
		roles.rows.map((row) => [row.rolname, row.rolsuper, row.rolbypassrls]),
		[
			["ditero_migrator", false, false],
			["ditero_runtime", false, false],
			["ditero_zero", true, false],
		],
	);
	await pool.query(
		"set role ditero_zero; create table zero_0.cnpg_probe (id integer primary key); create schema cnpg_unrelated; create table cnpg_unrelated.hidden (id integer); reset role",
	);
	const restrictedPool = new Pool({
		host: "127.0.0.1",
		port,
		user: "ditero_runtime",
		password,
		database: "ditero",
	});
	const client = await restrictedPool.connect();
	try {
		const identity = await client.query("select current_user, session_user");
		assert.deepEqual(identity.rows, [
			{ current_user: "ditero_runtime", session_user: "ditero_runtime" },
		]);
		await client.query(
			"insert into zero_0.cnpg_probe values (1); update zero_0.cnpg_probe set id=2; select * from zero_0.cnpg_probe; delete from zero_0.cnpg_probe",
		);
		await assert.rejects(
			client.query("set role ditero_migrator"),
			/permission denied/,
		);
		await assert.rejects(
			client.query("create table public.cnpg_illegal (id integer)"),
			/permission denied/,
		);
		await assert.rejects(
			client.query("select * from cnpg_unrelated.hidden"),
			/permission denied/,
		);
		await pool.query(
			"reset role; set role ditero_migrator; insert into zero_0.cnpg_probe values (3); reset role",
		);
		const protectedRows = await client.query(
			"select relrowsecurity,relforcerowsecurity from pg_class where oid='public.user_secret'::regclass",
		);
		assert.deepEqual(protectedRows.rows, [
			{ relrowsecurity: true, relforcerowsecurity: true },
		]);
		await pool.query("revoke usage on schema zero_0 from ditero_runtime");
		await assert.rejects(
			client.query("insert into zero_0.cnpg_probe values (4)"),
			/permission denied/,
		);
		await client.query("reset role");
	} finally {
		client.release();
		await restrictedPool.end();
	}
	console.log(
		"CloudNativePG bootstrap SQL, real migration owner, restricted runtime and shard grants passed.",
	);
} finally {
	await pool?.end();
	if (started) docker(["rm", "--force", name]);
}
