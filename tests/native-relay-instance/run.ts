import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const name = `ditero-instance-relay-${randomBytes(8).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), "ditero-instance-relay-"));
const password = randomBytes(32).toString("hex"),
	runtimePassword = randomBytes(32).toString("hex");
let container = false;
async function command(args: string[]): Promise<string> {
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(child.stdout).text();
	if ((await child.exited) !== 0)
		throw new Error("Owned instance fixture command failed");
	return output.trim();
}
try {
	const envFile = join(directory, "postgres.env");
	await writeFile(
		envFile,
		`POSTGRES_DB=ditero
POSTGRES_PASSWORD=${password}
`,
		{ mode: 0o600 },
	);
	await command([
		"docker",
		"run",
		"--detach",
		"--name",
		name,
		"--publish",
		"127.0.0.1::5432",
		"--env-file",
		envFile,
		"postgres:18@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20",
	]);
	container = true;
	const binding = await command(["docker", "port", name, "5432/tcp"]),
		port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
	if (!port) throw new Error("Owned fixture port invalid");
	const url = `postgres://postgres:${password}@127.0.0.1:${port}/ditero`,
		runtimeUrl = `postgres://relay_instance_runtime:${runtimePassword}@127.0.0.1:${port}/ditero`;
	const admin = new Pool({
		connectionString: url,
		connectionTimeoutMillis: 500,
		max: 1,
	});
	try {
		let ready = false;
		for (let i = 0; i < 60; i++) {
			try {
				await admin.query("select 1");
				ready = true;
				break;
			} catch {
				await Bun.sleep(250);
			}
		}
		if (!ready) throw new Error("Owned instance fixture startup failed");
		await migrate(drizzle(admin), { migrationsFolder: "drizzle" });
		await admin.query(
			`create role relay_instance_runtime login password '${runtimePassword}' nosuperuser nobypassrls nocreatedb nocreaterole noinherit`,
		);
		await admin.query("revoke create on schema public from public");
		await admin.query("grant usage on schema public to relay_instance_runtime");
		await admin.query(
			"grant select,insert,update,delete on all tables in schema public to relay_instance_runtime",
		);
		await admin.query(
			"revoke all on drizzle.__drizzle_migrations from relay_instance_runtime",
		);
	} finally {
		await admin.end();
	}
	const child = Bun.spawn(
		[
			"bunx",
			"vitest",
			"run",
			"tests/native-relay-instance/instance.test.ts",
			"--no-file-parallelism",
		],
		{
			env: {
				...process.env,
				NATIVE_RELAY_TEST_DATABASE_URL: runtimeUrl,
				NATIVE_RELAY_TEST_ADMIN_DATABASE_URL: url,
			},
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	process.exitCode = await child.exited;
} finally {
	if (container) await command(["docker", "rm", "--force", "--volumes", name]);
	await rm(directory, { recursive: true, force: true });
}
