import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This is deliberately a separate CI milestone: never run it against operator data.
const root =
	process.env.DITERO_AIO_TEST_SOURCE ||
	fileURLToPath(new URL("../../", import.meta.url));
const project = `ditero-aio-runtime-${randomBytes(8).toString("hex")}`;
const fixture = mkdtempSync(join(tmpdir(), `${project}-`));
chmodSync(fixture, 0o700);
const deadline = Date.now() + 12 * 60_000;
const credentialPaths = [];
const checks = [];
let passed = false;
let failure;
let cleaning = false;
let cleanupDeadline;
let admitted = false;
let phase = "prepare";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const check = (name, fn) => {
	fn();
	checks.push(name);
	console.log(`PASS ${name}`);
};

function command(
	program,
	args,
	{ input, timeout = 30_000, allowFailure = false } = {},
) {
	const remaining = Math.min(
		timeout,
		(cleaning ? cleanupDeadline : deadline) - Date.now(),
	);
	assert(remaining > 0, "runtime milestone deadline");
	const result = spawnSync(program, args, {
		cwd: root,
		env: process.env,
		input,
		encoding: "utf8",
		timeout: remaining,
		maxBuffer: 8 * 1024 * 1024,
	});
	// Keep diagnostics bounded and redact the fixture's generated credentials.
	if (result.error)
		throw new Error(`${program} transport failed: ${result.error.code}`);
	if (!allowFailure && result.status !== 0) {
		const stderr = (result.stderr || "")
			.replace(/[a-f0-9]{64}/gi, "[redacted]")
			.replace(/[A-Za-z0-9+/]{43}=/g, "[redacted]")
			.trim();
		const detail = stderr
			? `; stderr: ${stderr.slice(0, 4096)}${stderr.length > 4096 ? " [truncated]" : ""}`
			: "";
		throw new Error(
			`${phase}: ${program} failed with status ${result.status}${detail}`,
		);
	}
	return result;
}
const docker = (args, options) => command("docker", args, options);
const sudo = (args) => command("sudo", ["-n", ...args]);
const composeFile = join(fixture, "compose.json");
const compose = (args, options, file = composeFile) =>
	docker(
		["compose", "--project-name", project, "--file", file, ...args],
		options,
	);
const inspect = (id) => JSON.parse(docker(["inspect", id]).stdout)[0];
const service = (name) => {
	const ids = compose(["ps", "--all", "--quiet", name])
		.stdout.trim()
		.split(/\s+/)
		.filter(Boolean);
	assert.equal(ids.length, 1, `exactly one ${name} container`);
	const row = inspect(ids[0]);
	assert.equal(row.Config.Labels["com.docker.compose.project"], project);
	assert.equal(row.Config.Labels["com.docker.compose.service"], name);
	return row;
};
const exec = (id, script, input) =>
	docker(["exec", "-i", id, "/bin/sh", "-ec", script], { input });
const pause = () =>
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
function ready() {
	const until = Math.min(deadline, Date.now() + 300_000);
	while (Date.now() < until) {
		const rows = Object.fromEntries(
			["postgres", "migrate", "api", "zero"].map((name) => [
				name,
				service(name),
			]),
		);
		for (const name of ["postgres", "api", "zero"])
			assert(
				!["exited", "dead"].includes(rows[name].State.Status),
				`${name} exited before readiness`,
			);
		assert(
			!(
				rows.migrate.State.Status === "exited" &&
				rows.migrate.State.ExitCode !== 0
			),
			"migration failed",
		);
		if (
			["postgres", "api", "zero"].every(
				(name) => rows[name].State.Health?.Status === "healthy",
			) &&
			rows.migrate.State.Status === "exited" &&
			rows.migrate.State.ExitCode === 0
		)
			return rows;
		pause();
	}
	throw new Error("bundle readiness deadline");
}
function credentials(role, uid, values) {
	const dir = join(fixture, `${role}-credentials`);
	mkdirSync(dir, { mode: 0o700 });
	for (const [name, value] of Object.entries(values)) {
		const path = join(dir, name);
		writeFileSync(path, `${value}\n`, { mode: 0o600 });
		credentialPaths.push({ path, hash: hash(readFileSync(path)), uid });
		sudo(["chown", `${uid}:${uid}`, path]);
	}
	sudo(["chown", `${uid}:${uid}`, dir]);
	return dir;
}
const expectedMigrations = JSON.parse(
	readFileSync(join(root, "drizzle/meta/_journal.json")),
).entries.map((entry) =>
	hash(readFileSync(join(root, "drizzle", `${entry.tag}.sql`))),
);
function databaseIdentity(id) {
	const sql =
		"BEGIN READ ONLY; SELECT system_identifier FROM pg_control_system(); SELECT count(*) FROM drizzle.__drizzle_migrations; SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id; COMMIT;\n";
	const result = docker(
		[
			"exec",
			"-i",
			id,
			"psql",
			"--host=/run/ditero/postgres",
			"--username=ditero_pgadmin",
			"--dbname=ditero",
			"--tuples-only",
			"--no-align",
			"--set",
			"ON_ERROR_STOP=1",
		],
		{ input: sql },
	)
		.stdout.trim()
		.split("\n");
	assert.equal(result[0], "BEGIN");
	assert.match(result[1], /^\d+$/);
	assert.equal(Number(result[2]), expectedMigrations.length);
	assert.deepEqual(result.slice(3, -1), expectedMigrations);
	assert.equal(result.at(-1), "COMMIT");
	return result[1];
}
function rejection(config, name, expected) {
	assert.match(name, /^[a-z0-9-]+$/);
	const file = join(fixture, `${name}.json`);
	writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
	const result = compose(
		[
			"run",
			"--pull",
			"never",
			"--no-deps",
			"--rm",
			"--name",
			`${project}-${name}`,
			"api",
		],
		{
			timeout: 30_000,
			allowFailure: true,
		},
		file,
	);
	assert.notEqual(result.status, 0, `${name} must reject`);
	assert.match(
		result.stdout + result.stderr,
		expected,
		`${name} must reach intended guard`,
	);
	checks.push(name);
	console.log(`PASS ${name}`);
}
let config;
try {
	const image = docker([
		"image",
		"inspect",
		process.env.DITERO_AIO_TEST_IMAGE || "ditero-aio:check",
	]).stdout;
	const imageID = JSON.parse(image)[0].Id;
	assert.match(imageID, /^sha256:[0-9a-f]{64}$/);
	const secret = () => randomBytes(32).toString("hex");
	const pg = {
		POSTGRES_PASSWORD: secret(),
		DITERO_MIGRATION_DB_PASSWORD: secret(),
		DITERO_RUNTIME_DB_PASSWORD: secret(),
		ZERO_DATABASE_PASSWORD: secret(),
	};
	const env = {
		...process.env,
		DITERO_AIO_IMAGE: imageID,
		AIO_POSTGRES_SECRETS: credentials("postgres", 1001, pg),
		AIO_MIGRATE_SECRETS: credentials("migrate", 1000, {
			DITERO_MIGRATION_DB_PASSWORD: pg.DITERO_MIGRATION_DB_PASSWORD,
		}),
		AIO_API_SECRETS: credentials("api", 1000, {
			DITERO_RUNTIME_DB_PASSWORD: pg.DITERO_RUNTIME_DB_PASSWORD,
			BETTER_AUTH_SECRET: secret(),
			DITERO_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		}),
		AIO_ZERO_SECRETS: credentials("zero", 1002, {
			ZERO_DATABASE_PASSWORD: pg.ZERO_DATABASE_PASSWORD,
			ZERO_ADMIN_PASSWORD: secret(),
		}),
		BETTER_AUTH_URL: "http://localhost:3000",
		PUBLIC_ZERO_URL: "http://localhost:4848",
	};
	// Render the real topology, changing only published ports to kernel-assigned loopback ports.
	const rendered = spawnSync(
		"docker",
		[
			"compose",
			"--project-name",
			project,
			"--file",
			join(root, "deploy/docker/aio/compose.yml"),
			"config",
			"--format",
			"json",
		],
		{ env, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
	);
	assert.equal(rendered.status, 0, "Compose render");
	config = JSON.parse(rendered.stdout);
	for (const name of ["api", "zero"])
		for (const port of config.services[name].ports) port.published = "0";
	for (const role of Object.values(config.services))
		assert.equal(role.image, imageID);
	writeFileSync(composeFile, JSON.stringify(config), { mode: 0o600 });
	assert.equal(
		compose(["ps", "--all", "--quiet"]).stdout.trim(),
		"",
		"fresh project",
	);
	for (const volume of Object.values(config.volumes)) {
		const result = docker(["volume", "inspect", volume.name], {
			allowFailure: true,
		});
		assert.notEqual(result.status, 0, "fresh named volume");
		assert.match(result.stderr, /no such volume/i);
	}
	assert.equal(
		docker([
			"network",
			"ls",
			"--quiet",
			"--filter",
			`label=com.docker.compose.project=${project}`,
		]).stdout.trim(),
		"",
		"fresh project networks",
	);
	admitted = true;
	phase = "fresh startup";
	compose(["up", "--detach", "--no-build", "--pull", "never"], {
		timeout: 300_000,
	});
	const rows = ready();
	check("fresh migration and API/Zero health", () =>
		assert.equal(rows.migrate.State.ExitCode, 0),
	);
	const mounts = {
		postgres: ["/run/credentials", "/var/lib/ditero/pg18"],
		migrate: ["/run/credentials"],
		api: ["/run/credentials", "/var/lib/ditero/attachments"],
		zero: ["/run/credentials", "/var/lib/ditero/zero"],
	};
	for (const [name, uid] of [
		["postgres", 1001],
		["migrate", 1000],
		["api", 1000],
		["zero", 1002],
	]) {
		const row = rows[name];
		check(`${name} image and security configuration`, () => {
			assert.equal(row.Image, imageID);
			assert.equal(row.Config.User, `${uid}:${uid}`);
			assert.equal(row.HostConfig.ReadonlyRootfs, true);
			assert.equal(row.HostConfig.Privileged, false);
			assert.deepEqual(row.HostConfig.CapAdd || [], []);
			assert.deepEqual(row.HostConfig.CapDrop, ["ALL"]);
			assert.deepEqual(row.HostConfig.GroupAdd || [], []);
			assert(row.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
			assert.deepEqual(
				row.Mounts.filter((mount) => mount.Type !== "tmpfs")
					.map((mount) => mount.Destination)
					.sort(),
				mounts[name].sort(),
			);
			assert.equal(
				row.Mounts.find((mount) => mount.Destination === "/run/credentials").RW,
				false,
			);
		});
		if (name === "migrate") continue; // Its successful child has already been reaped.
		const status = exec(
			row.Id,
			"id -u; id -G; cat /proc/1/status; cat /proc/self/mountinfo; if touch /app/aio-runtime-forbidden 2>/dev/null; then exit 90; fi",
		).stdout;
		check(`${name} actual UID/groups/capabilities and readonly root`, () => {
			assert.equal(Number(status.split("\n")[0]), uid);
			assert.equal(status.split("\n")[1], String(uid));
			assert.match(status, /^CapEff:\s+0+$/m);
			assert.match(status, /^NoNewPrivs:\s+1$/m);
			assert.match(status, /^\S+ \S+ \S+ \/ \/ ro(?:,|\s)/m);
		});
		const target = mounts[name].find((path) => path.startsWith("/var/lib/"));
		check(`${name} fresh volume ownership`, () =>
			assert.equal(
				exec(row.Id, `stat -c '%u:%g:%a' ${target}`).stdout.trim(),
				`${uid}:${uid}:700`,
			),
		);
	}
	const identity = databaseIdentity(rows.postgres.Id);
	checks.push("all current migrations and PostgreSQL identity");
	const sentinel = randomBytes(32).toString("hex");
	exec(
		rows.api.Id,
		"umask 077; cat > /var/lib/ditero/attachments/aio-runtime-sentinel",
		sentinel,
	);
	const volumes = Object.fromEntries(
		Object.entries(rows).map(([name, row]) => [
			name,
			row.Mounts.filter((mount) => mount.Type === "volume").map(
				(mount) => mount.Name,
			),
		]),
	);
	phase = "retained restart";
	compose(["stop", "--timeout", "30"], { timeout: 120_000 });
	compose(["up", "--detach", "--no-build", "--pull", "never"], {
		timeout: 300_000,
	});
	const retained = ready();
	check("retained restart identity, migrations and attachment bytes", () => {
		assert.equal(databaseIdentity(retained.postgres.Id), identity);
		assert.equal(
			exec(
				retained.api.Id,
				"cat /var/lib/ditero/attachments/aio-runtime-sentinel",
			).stdout,
			sentinel,
		);
		for (const [name, row] of Object.entries(retained))
			assert.deepEqual(
				row.Mounts.filter((mount) => mount.Type === "volume").map(
					(mount) => mount.Name,
				),
				volumes[name],
			);
	});
	phase = "scoped unsafe-input rejection";
	const wrongFile = structuredClone(config);
	wrongFile.services.api.environment.DITERO_RUNTIME_DB_PASSWORD_FILE =
		"/run/credentials/absent";
	rejection(
		wrongFile,
		"missing-credential-file",
		/DITERO_RUNTIME_DB_PASSWORD_FILE: file is not readable/,
	);
	const wrongOwnerDir = credentials("wrong-owner", 1002, {
		DITERO_RUNTIME_DB_PASSWORD: pg.DITERO_RUNTIME_DB_PASSWORD,
	});
	const wrongOwner = structuredClone(config);
	wrongOwner.services.api.volumes.find(
		(mount) => mount.target === "/run/credentials",
	).source = wrongOwnerDir;
	rejection(
		wrongOwner,
		"wrong-credential-owner",
		/parent must be owned by the role|EACCES/,
	);
	const wrongMountDir = join(fixture, "wrong-mount");
	mkdirSync(wrongMountDir, { mode: 0o755 });
	chmodSync(wrongMountDir, 0o755);
	sudo(["chown", "1002:1002", wrongMountDir]);
	const wrongMount = structuredClone(config);
	const mount = wrongMount.services.api.volumes.find(
		(volume) => volume.target === "/var/lib/ditero/attachments",
	);
	mount.type = "bind";
	mount.source = wrongMountDir;
	delete mount.volume;
	mount.bind = { create_host_path: false };
	rejection(
		wrongMount,
		"wrong-data-mount-owner",
		/api empty volume requires role ownership and mode0700/,
	);
	phase = "essential child failure";
	// Kill only the actual API child; its guardian must fail rather than silently stay up.
	exec(
		retained.api.Id,
		'children=$(cat /proc/1/task/1/children); set -- $children; test $# -eq 1; guardian=$1; target=; for child in $(cat /proc/$guardian/task/$guardian/children); do executable=$(readlink /proc/$child/exe 2>/dev/null || true); if [ "$executable" = /usr/local/bin/bun ]; then test -z "$target"; target=$child; fi; done; test -n "$target"; kill -KILL "$target"',
	);
	const failedUntil = Date.now() + 30_000;
	while (Date.now() < failedUntil && inspect(retained.api.Id).State.Running)
		pause();
	check("essential API child failure exits guardian", () => {
		const state = inspect(retained.api.Id).State;
		assert.equal(state.Running, false);
		assert.notEqual(state.ExitCode, 0);
	});
	phase = "retained credential bytes and metadata";
	for (const entry of credentialPaths) {
		const actual = command("sudo", [
			"-n",
			"sha256sum",
			entry.path,
		]).stdout.split(/\s+/)[0];
		assert.equal(actual, entry.hash, "retained original credential bytes");
		const metadata = command("sudo", [
			"-n",
			"stat",
			"-c",
			"%u:%g:%a",
			entry.path,
		]).stdout.trim();
		assert.equal(
			metadata,
			`${entry.uid}:${entry.uid}:600`,
			"retained credential owner/mode",
		);
	}
	checks.push("retained credential bytes and metadata");
	passed = true;
} catch (error) {
	failure = error;
	console.error(`AIO runtime phase failed: ${phase}`);
} finally {
	cleaning = true;
	cleanupDeadline = Date.now() + 180_000;
	phase = "scoped cleanup";
	let cleanupFailure;
	try {
		if (admitted) {
			compose(["down", "--timeout", "30", "--remove-orphans"], {
				timeout: 150_000,
			});
			// A timed-out Compose run can leave its one-off child alive after its CLI exits.
			const leftoverIDs = docker([
				"ps",
				"--all",
				"--quiet",
				"--filter",
				`label=com.docker.compose.project=${project}`,
			])
				.stdout.trim()
				.split(/\s+/)
				.filter(Boolean);
			const leftovers = leftoverIDs.map(inspect);
			for (const row of leftovers) {
				assert.equal(row.Config.Labels["com.docker.compose.project"], project);
				assert.equal(row.Config.Labels["com.docker.compose.service"], "api");
				assert.equal(row.Image, config.services.api.image);
				assert(
					[
						"missing-credential-file",
						"wrong-credential-owner",
						"wrong-data-mount-owner",
					].some((name) => row.Name === `/${project}-${name}`),
				);
			}
			for (const row of leftovers) {
				if (row.State.Running) docker(["stop", "--time", "30", row.Id]);
				docker(["rm", row.Id]);
			}
			assert.equal(
				docker([
					"ps",
					"--all",
					"--quiet",
					"--filter",
					`label=com.docker.compose.project=${project}`,
				]).stdout.trim(),
				"",
			);
			assert.equal(
				docker([
					"network",
					"ls",
					"--quiet",
					"--filter",
					`label=com.docker.compose.project=${project}`,
				]).stdout.trim(),
				"",
			);
			if (passed)
				for (const volume of Object.values(config.volumes)) {
					const row = JSON.parse(
						docker(["volume", "inspect", volume.name]).stdout,
					)[0];
					assert.equal(row.Labels["com.docker.compose.project"], project);
					docker(["volume", "rm", volume.name]);
				}
		}
	} catch (error) {
		cleanupFailure = error;
	}
	writeFileSync(
		join(fixture, "receipt.json"),
		JSON.stringify(
			{
				project,
				phase,
				passed,
				checks,
				volumesRetained: !passed,
				cleanupPassed: !cleanupFailure,
				pending: [
					"actual registry-digest wrapper TERM/reaping",
					"steady-state health failure propagation",
				],
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	// Keep failed fixture credentials private for scoped CI recovery; never dump them.
	if (passed && !cleanupFailure) {
		for (const name of ["postgres", "migrate", "api", "zero", "wrong-owner"])
			sudo([
				"chown",
				`${process.getuid()}:${process.getgid()}`,
				join(fixture, `${name}-credentials`),
			]);
		for (const entry of credentialPaths)
			sudo(["chown", `${process.getuid()}:${process.getgid()}`, entry.path]);
		sudo([
			"chown",
			`${process.getuid()}:${process.getgid()}`,
			join(fixture, "wrong-mount"),
		]);
		rmSync(fixture, { recursive: true });
	} else
		console.error(
			`AIO runtime fixture retained for scoped recovery: ${project}`,
		);
	if (cleanupFailure) {
		console.error("AIO scoped cleanup failed; original failure preserved");
		failure ??= cleanupFailure;
	}
}
if (failure) throw failure;
console.log(`AIO actual runtime: ${checks.length} checks passed`);
