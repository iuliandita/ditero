import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildConfiguration,
	defaultReadSecretFile,
	parseSecretFileContent,
	startHealthMonitor,
	validateClusterState,
	validateVolumeTopdir,
} from "../../deploy/docker/aio/rootfs/usr/local/lib/ditero-aio/config.mjs";

let checks = 0;
const check = (fn) => {
	fn();
	checks++;
};
const pg = {
	POSTGRES_PASSWORD: "admin synthetic",
	DITERO_MIGRATION_DB_PASSWORD: "migration synthetic",
	DITERO_RUNTIME_DB_PASSWORD: "runtime synthetic",
	ZERO_DATABASE_PASSWORD: "replication synthetic",
};
const api = {
	DITERO_RUNTIME_DB_PASSWORD: pg.DITERO_RUNTIME_DB_PASSWORD,
	BETTER_AUTH_SECRET: "auth synthetic",
	DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
	BETTER_AUTH_URL: "https://example.com",
	PUBLIC_ZERO_URL: "https://sync.example.com",
};
for (const [role, env, uid] of [
	["postgres", pg, 1001],
	[
		"migrate",
		{ DITERO_MIGRATION_DB_PASSWORD: pg.DITERO_MIGRATION_DB_PASSWORD },
		1000,
	],
	["api", api, 1000],
	[
		"zero",
		{
			ZERO_DATABASE_PASSWORD: pg.ZERO_DATABASE_PASSWORD,
			ZERO_ADMIN_PASSWORD: "zero admin synthetic",
		},
		1002,
	],
]) {
	const config = buildConfiguration(role, env);
	check(() => assert.equal(config.uid, uid));
	if (role !== "postgres")
		check(() => assert.equal(config.env.POSTGRES_PASSWORD, undefined));
	if (role !== "api")
		check(() => assert.equal(config.env.DITERO_ENCRYPTION_KEY, undefined));
	if (role !== "zero")
		check(() => assert.equal(config.env.ZERO_ADMIN_PASSWORD, undefined));
	check(() =>
		assert.throws(() =>
			buildConfiguration(role, {
				...env,
				[role === "api" ? "POSTGRES_PASSWORD" : "BETTER_AUTH_SECRET"]:
					"foreign",
			}),
		),
	);
}
check(() =>
	assert.throws(() =>
		buildConfiguration("api", { ...api, NODE_OPTIONS: "--inspect" }),
	),
);
check(() =>
	assert.throws(() => buildConfiguration("api", { ...api, API_PORT: "9999" })),
);
check(() =>
	assert.throws(() =>
		buildConfiguration(
			"api",
			{ ...api, DITERO_RUNTIME_DB_PASSWORD_FILE: "/synthetic" },
			() => "file value",
		),
	),
);
check(() =>
	assert.throws(() =>
		buildConfiguration("postgres", {
			...pg,
			ZERO_DATABASE_PASSWORD: pg.POSTGRES_PASSWORD,
		}),
	),
);
check(() =>
	assert.equal(
		parseSecretFileContent("X", Buffer.from(" secret with spaces \r\n")),
		" secret with spaces ",
	),
);
check(() =>
	assert.throws(() => parseSecretFileContent("X", Buffer.from("bad\nvalue"))),
);
const top = { exists: true, type: "dir", uid: 1001, mode: 0o700, entries: [] };
check(() =>
	assert.deepEqual(validateVolumeTopdir(top, { name: "postgres", uid: 1001 }), {
		fresh: true,
		adopt: false,
	}),
);
check(() =>
	assert.throws(() =>
		validateVolumeTopdir({ ...top, uid: 0 }, { name: "postgres", uid: 1001 }),
	),
);
check(() =>
	assert.throws(() =>
		validateVolumeTopdir(
			{ ...top, mode: 0o755 },
			{ name: "postgres", uid: 1001 },
		),
	),
);
check(() =>
	assert.throws(() =>
		validateClusterState({
			topdir: { ...top, entries: ["data", "ditero-init.state"] },
			data: { ...top, entries: ["PG_VERSION"] },
			pgVersion: "18\n",
			marker: "initdb-complete\n",
		}),
	),
);
const zero = buildConfiguration("zero", {
	ZERO_DATABASE_PASSWORD: pg.ZERO_DATABASE_PASSWORD,
	ZERO_ADMIN_PASSWORD: "admin",
});
check(() =>
	assert.equal(zero.env.ZERO_QUERY_URL, "http://api:3000/api/zero/query"),
);
check(() =>
	assert.equal(new URL(zero.env.ZERO_UPSTREAM_DB).hostname, "postgres"),
);
check(() => assert.equal(zero.env.ZERO_ENABLE_CRUD_MUTATIONS, "false"));
const dir = mkdtempSync(join(tmpdir(), "ditero-aio-source-"));
try {
	const file = join(dir, "credential");
	writeFileSync(file, "synthetic", { mode: 0o600 });
	check(() =>
		assert.equal(defaultReadSecretFile(file).toString(), "synthetic"),
	);
	chmodSync(file, 0o644);
	check(() => assert.throws(() => defaultReadSecretFile(file)));
	chmodSync(file, 0o600);
	const link = join(dir, "link");
	symlinkSync(file, link);
	check(() => assert.throws(() => defaultReadSecretFile(link)));
	chmodSync(dir, 0o755);
	check(() => assert.throws(() => defaultReadSecretFile(file)));
	chmodSync(dir, 0o700);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

check(() =>
	assert.throws(() =>
		buildConfiguration("zero", {
			ZERO_DATABASE_PASSWORD: "replication",
			ZERO_ADMIN_PASSWORD: "admin",
			DITERO_SMTP_PASSWORD: "foreign",
		}),
	),
);

// Exercise the actual monitor's consecutive-failure reset and terminal callback.
await new Promise((resolve, reject) => {
	const results = [true, false, false, true, false, false, false];
	let probes = 0;
	const deadline = setTimeout(() => {
		cancel();
		reject(new Error("monitor deadline"));
	}, 2000);
	const cancel = startHealthMonitor({
		intervalMs: 1,
		startupMs: 0,
		probe: async () => results[probes++],
		onFailure: () => {
			clearTimeout(deadline);
			try {
				assert.equal(probes, 7);
				checks++;
				resolve();
			} catch (error) {
				reject(error);
			}
		},
	});
});

// A fake Compose executable exercises host process ownership without Docker.
const lifecycle = mkdtempSync(join(tmpdir(), "ditero-aio-lifecycle-"));
const wrapper = fileURLToPath(
	new URL("../../deploy/docker/aio/run-bundle.sh", import.meta.url),
);
const configuration = new URL(
	"../../deploy/docker/aio/rootfs/usr/local/lib/ditero-aio/config.mjs",
	import.meta.url,
).href;
const fakeDocker = join(lifecycle, "docker");
writeFileSync(
	fakeDocker,
	`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = name => path.join(process.env.AIO_TEST_DIR, name);
const args = process.argv.slice(2);
if (args.includes("config")) process.exit(0);
if (args.includes("stop")) {
 fs.writeFileSync(file("stopped"), "scoped graph stopped");
 try { process.kill(Number(fs.readFileSync(file("up-pid"), "utf8")), "SIGTERM"); } catch(error) { if(error.code !== "ESRCH") throw error; }
 process.exit(0);
}
if (!args.includes("up")) process.exit(2);
fs.writeFileSync(file("up-pid"), String(process.pid));
if (process.env.AIO_TEST_MODE === "failure") process.exit(7);
process.on("SIGTERM", () => { fs.writeFileSync(file("reaped"), "terminated"); process.exit(0); });
if (process.env.AIO_TEST_MODE === "health") {
 import(process.env.AIO_TEST_CONFIG).then(({startHealthMonitor}) => {
  let probes = 0;
  startHealthMonitor({intervalMs: 5, startupMs: 0, probe: async () => ++probes === 1,
   onFailure: () => { fs.writeFileSync(file("health-failed"), String(probes)); process.exit(1); }});
 });
} else setInterval(() => {}, 1000);
`,
	{ mode: 0o700 },
);
async function lifecycleCase(mode) {
	const caseDir = join(lifecycle, mode);
	// Keep each mocked graph's receipt separate.
	const { mkdirSync } = await import("node:fs");
	mkdirSync(caseDir, { mode: 0o700 });
	// Instrument shell builtins while sourcing unchanged wrapper bytes. The
	// wrapper stays $0 so its own relative Compose path remains unchanged.
	const shellArgs =
		mode === "failure"
			? [
					"-c",
					`
kill() { printf '%s\\n' "$*" >> "$AIO_TEST_DIR/kill-calls"; command kill "$@"; }
wait() { printf '%s\\n' "$*" >> "$AIO_TEST_DIR/wait-calls"; command wait "$@"; }
. "$0"
`,
					wrapper,
				]
			: [wrapper];
	const child = spawn("sh", shellArgs, {
		env: {
			...process.env,
			PATH: `${lifecycle}:${process.env.PATH}`,
			DITERO_AIO_IMAGE: `example/image@sha256:${"1".repeat(64)}`,
			AIO_TEST_DIR: caseDir,
			AIO_TEST_MODE: mode,
			AIO_TEST_CONFIG: configuration,
		},
		stdio: "ignore",
	});
	let upPid;
	let completed = false;
	const completion = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
	try {
		const until = Date.now() + 2000;
		while (!existsSync(join(caseDir, "up-pid"))) {
			assert.ok(Date.now() < until, "mock Compose did not start");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		upPid = Number(readFileSync(join(caseDir, "up-pid"), "utf8"));
		if (mode === "term") child.kill("SIGTERM"); // Only the host wrapper receives this signal.
		const result = await completion;
		completed = true;
		assert.deepEqual(result, {
			code: mode === "term" ? 143 : mode === "failure" ? 7 : 1,
			signal: null,
		});
		assert.ok(existsSync(join(caseDir, "stopped")));
		assert.throws(() => process.kill(upPid, 0), { code: "ESRCH" });
		if (mode === "term") assert.ok(existsSync(join(caseDir, "reaped")));
		else if (mode === "failure") {
			assert.equal(existsSync(join(caseDir, "kill-calls")), false);
			assert.equal(
				readFileSync(join(caseDir, "wait-calls"), "utf8"),
				`${upPid}\n`,
			);
			checks++;
		} else
			assert.equal(readFileSync(join(caseDir, "health-failed"), "utf8"), "4");
		checks += 4;
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		if (upPid && !completed) {
			try {
				process.kill(upPid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") {
					console.error("Owned mock process cleanup failed", error);
					process.exitCode = 1;
				}
			}
		}
	}
}
try {
	await lifecycleCase("term");
	await lifecycleCase("health");
	await lifecycleCase("failure");
} finally {
	rmSync(lifecycle, { recursive: true, force: true });
}
console.log(`${checks} source controls passed; no runtime qualification`);
