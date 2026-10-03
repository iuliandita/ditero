import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";

const image =
	"postgres:18@sha256:4aabea78cf39b90e834caf3af7d602a18565f6fe2508705c8d01aa63245c2e20";
class QualificationError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new QualificationError(message);
}
async function docker(args: string[]) {
	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
	try {
		const [exit, stdout] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		assert(exit === 0, "Owned container operation failed");
		return { exit, stdout };
	} finally {
		clearTimeout(timer);
	}
}
type DockerRunner = (
	args: string[],
) => Promise<{ exit: number; stdout: string }>;
async function cleanupContainer(
	name: string,
	created: boolean,
	run: DockerRunner = docker,
) {
	const remove = async () => {
		const result = await run(["rm", "--force", name]);
		assert(result.exit === 0, "Owned container removal failed");
	};
	const remaining = async () => {
		const result = await run([
			"ps",
			"--all",
			"--filter",
			`name=^/${name}$`,
			"--format",
			"{{.Names}}",
		]);
		assert(result.exit === 0, "Owned container absence query failed");
		return result.stdout.trim();
	};
	if (created) await remove();
	let found = await remaining();
	if (!created && found === name) {
		await remove();
		found = await remaining();
	}
	assert(found === "", "Owned container was not removed");
}
async function failureControls() {
	for (const args of [
		["--unexpected-control"],
		["--cleanup-control=unknown"],
		["--cleanup-control=remove", "--extra"],
		["--cleanup-control=remove", "--cleanup-control=query"],
	]) {
		const proc = Bun.spawn([process.execPath, import.meta.path, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
		try {
			const [exit, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			assert(
				exit === 1 && stderr.includes("Invalid qualification arguments"),
				"Unknown or extra qualification arguments did not fail",
			);
			assert(
				!stdout.includes("passed"),
				"Invalid arguments falsely claimed qualification",
			);
		} finally {
			clearTimeout(timer);
		}
	}
	for (const mode of ["remove", "query", "present", "startup"] as const) {
		const proc = Bun.spawn(
			[process.execPath, import.meta.path, `--cleanup-control=${mode}`],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
		try {
			const [exit, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stderr).text(),
				new Response(proc.stdout).text(),
			]);
			assert(exit === 1, "Synthetic cleanup failure did not exit nonzero");
			const reason = {
				remove: "Owned container removal failed",
				query: "Owned container absence query failed",
				present: "Owned container was not removed",
				startup: "Synthetic original startup failure",
			}[mode];
			assert(
				reason && stderr.includes(reason),
				"Synthetic cleanup failure lost its cause",
			);
		} finally {
			clearTimeout(timer);
		}
	}
	console.log("postgres-init-secrets: cleanup failure controls passed");
}
const wrapper = `#!/bin/sh
set -eu
real=/usr/lib/postgresql/18/bin/psql
case " $* " in
*--set=zero_shard_schema=*) ;;
*) exec "$real" "$@" ;;
esac
fifo=/tmp/ditero-psql-input
mkfifo "$fifo"
"$real" "$@" < "$fifo" &
pid=$!
trap 'kill "$pid" 2>/dev/null || :; rm -f "$fifo"' EXIT
exec 3> "$fifo"
n=0
while [ "$(readlink /proc/$pid/exe)" != "$real" ]; do
 n=$((n + 1))
 [ "$n" -lt 100 ] || exit 1
 sleep 0.01
done
cat /proc/$pid/cmdline > /tmp/ditero-psql-argv
cat >&3
exec 3>&-
wait "$pid"
`;
const prepare = `set -eu
mkdir -p /tmp/ditero-secrets
cp /probe/migration /tmp/ditero-secrets/migration
cp /probe/runtime /tmp/ditero-secrets/runtime
chown -R postgres:postgres /tmp/ditero-secrets
chmod 600 /tmp/ditero-secrets/*
export PATH=/probe/bin:$PATH
exec /usr/local/bin/docker-entrypoint.sh postgres`;
async function qualify(mode: "inline" | "file") {
	const name = `ditero-init-secrets-${randomUUID()}`;
	const directory = await mkdtemp(join(tmpdir(), "ditero-init-secrets-"));
	const passwords = {
		migration: `migration-${randomUUID()}-'quote\\backslash`,
		runtime: `runtime-${randomUUID()}-'quote\\backslash`,
	};
	let created = false;
	let admin: Pool | undefined;
	const pools: Pool[] = [];
	try {
		await chmod(directory, 0o755);
		await writeFile(join(directory, "migration"), passwords.migration, {
			mode: 0o600,
		});
		await writeFile(join(directory, "runtime"), passwords.runtime, {
			mode: 0o600,
		});
		await mkdir(join(directory, "bin"));
		await writeFile(join(directory, "bin", "psql"), wrapper, { mode: 0o755 });
		const variables = [
			"POSTGRES_USER=postgres",
			"POSTGRES_DB=ditero",
			`POSTGRES_PASSWORD=admin-${randomUUID()}`,
		];
		if (mode === "inline")
			variables.push(
				`DITERO_MIGRATION_DB_PASSWORD=${passwords.migration}`,
				`DITERO_RUNTIME_DB_PASSWORD=${passwords.runtime}`,
			);
		else
			variables.push(
				"DITERO_MIGRATION_DB_PASSWORD_FILE=/tmp/ditero-secrets/migration",
				"DITERO_RUNTIME_DB_PASSWORD_FILE=/tmp/ditero-secrets/runtime",
			);
		await writeFile(join(directory, "env"), variables.join("\n"), {
			mode: 0o600,
		});
		await docker([
			"run",
			"--detach",
			"--name",
			name,
			"--env-file",
			join(directory, "env"),
			"--publish",
			"127.0.0.1::5432",
			"--tmpfs",
			"/var/lib/postgresql:rw",
			"--mount",
			`type=bind,src=${directory},dst=/probe,readonly`,
			"--mount",
			`type=bind,src=${join(directory, "bin", "psql")},dst=/probe/bin/psql,readonly`,
			"--mount",
			`type=bind,src=${resolve("deploy/docker/secret-file.sh")},dst=/usr/local/lib/ditero/secret-file.sh,readonly`,
			"--mount",
			`type=bind,src=${resolve("deploy/docker/postgres-init.sh")},dst=/docker-entrypoint-initdb.d/10-ditero.sh,readonly`,
			"--entrypoint",
			"sh",
			image,
			"-c",
			prepare,
		]);
		created = true;
		const published = (await docker(["port", name, "5432/tcp"])).stdout.trim();
		assert(/^127\.0\.0\.1:\d+$/.test(published), "Owned port is not loopback");
		const port = Number(published.split(":")[1]);
		admin = new Pool({
			host: "127.0.0.1",
			port,
			user: "postgres",
			password: variables[2].slice("POSTGRES_PASSWORD=".length),
			database: "ditero",
			connectionTimeoutMillis: 500,
		});
		let ready = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				const rows = (
					await admin.query(
						"select count(*)::int n from pg_roles where rolname in ('ditero_migrator','ditero_runtime')",
					)
				).rows;
				ready = rows[0].n === 2;
			} catch {}
			if (ready) break;
			await Bun.sleep(250);
		}
		assert(ready, "Owned PostgreSQL initializer did not become ready");
		const argv = (await docker(["exec", name, "cat", "/tmp/ditero-psql-argv"]))
			.stdout;
		assert(
			argv.includes("psql\0") &&
				argv.includes("--set=zero_shard_schema=zero_0\0"),
			"Actual live initializer psql argv was not captured",
		);
		assert(
			!Object.values(passwords).some((password) => argv.includes(password)),
			"Initializer leaked a password in actual psql argv",
		);
		assert(
			!argv.includes("--set=migration_password=") &&
				!argv.includes("--set=runtime_password="),
			"Initializer passed password variables in psql argv",
		);
		assert(
			(
				await admin.query("show server_version_num")
			).rows[0].server_version_num.startsWith("18"),
			"Qualification requires PostgreSQL 18",
		);
		await admin.query(
			"create table zero_0.probe (id serial primary key, value text)",
		);
		for (const user of ["ditero_migrator", "ditero_runtime"] as const) {
			const pool = new Pool({
				host: "127.0.0.1",
				port,
				user,
				password:
					user === "ditero_migrator" ? passwords.migration : passwords.runtime,
				database: "ditero",
				connectionTimeoutMillis: 1000,
			});
			pools.push(pool);
			const flags = (
				await pool.query(
					"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
				)
			).rows[0];
			assert(
				!flags.rolsuper && !flags.rolbypassrls,
				"Created role is not restricted",
			);
			await pool.query("insert into zero_0.probe (value) values ('initial')");
			await pool.query("select * from zero_0.probe");
			await pool.query("update zero_0.probe set value='updated'");
			await pool.query("delete from zero_0.probe");
		}
		await admin.query("revoke insert on zero_0.probe from ditero_runtime");
		let rejected = false;
		try {
			await pools[1].query(
				"insert into zero_0.probe (value) values ('refused')",
			);
		} catch (error) {
			rejected =
				error instanceof Error && "code" in error && error.code === "42501";
		}
		assert(rejected, "Revoked shard INSERT did not fail");
		console.log(
			`postgres-init-secrets: ${mode} authentication, live argv, shard grants and revoked control passed`,
		);
	} finally {
		for (const pool of pools) await pool.end();
		await admin?.end();
		try {
			await cleanupContainer(name, created);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
try {
	const args = process.argv.slice(2);
	const allowed = [
		"--cleanup-control=remove",
		"--cleanup-control=query",
		"--cleanup-control=present",
		"--cleanup-control=startup",
	];
	assert(
		args.length === 0 || (args.length === 1 && allowed.includes(args[0])),
		"Invalid qualification arguments",
	);
	const control = args[0]?.slice("--cleanup-control=".length);
	if (control) {
		const run: DockerRunner = async (args) => ({
			exit:
				(args[0] === "rm" && control === "remove") ||
				(args[0] === "ps" && control === "query")
					? 1
					: 0,
			stdout:
				args[0] === "ps" && control === "present" ? "synthetic-owned\n" : "",
		});
		if (control === "startup") {
			try {
				throw new QualificationError("Synthetic original startup failure");
			} finally {
				await cleanupContainer("synthetic-owned", false, run);
			}
		} else {
			await cleanupContainer("synthetic-owned", true, run);
		}
	} else {
		await failureControls();
		await qualify("inline");
		await qualify("file");
	}
} catch (error) {
	if (error instanceof QualificationError) console.error(error.message);
	console.error(
		"postgres-init-secrets: qualification failed (details withheld to keep password canaries private)",
	);
	process.exitCode = 1;
}
