import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Checkout-free qualification of the packaged, unmodified lifecycle owner.
assert.equal(
	process.argv.length,
	4,
	"usage: <packaged aio directory> <registry@digest>",
);
const bundle = realpathSync(resolve(process.argv[2]));
const image = process.argv[3];
assert.match(image, /^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/);
assert(!image.startsWith("sha256:"), "a registry digest is required");
const wrapper = join(bundle, "run-bundle.sh");
const composeFile = join(bundle, "compose.yml");
for (const path of [wrapper, composeFile]) {
	assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
	assert.equal(realpathSync(path), path);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageRoot = realpathSync(join(bundle, "../../.."));
assert.equal(
	bundle,
	join(packageRoot, "deploy/docker/aio"),
	"canonical package layout",
);
const packageFile = (name) => {
	assert(
		!name.startsWith("/") &&
			name.split("/").every((p) => p !== "" && p !== "." && p !== ".."),
		"safe package member",
	);
	const path = join(packageRoot, name);
	assert.equal(realpathSync(path), path, "nonsymlink package member");
	assert(lstatSync(path).isFile(), "regular package member");
	return readFileSync(path);
};
const source = JSON.parse(packageFile("SOURCE.json"));
const inventory = JSON.parse(packageFile("IMAGE-INVENTORY.json"));
assert.match(source.sourceSHA, /^[0-9a-f]{40}$/);
assert.equal(source.experimental, true);
assert.equal(source.runtimeQualified, false);
assert.equal(source.workflow, "aio-experimental.yml");
assert.equal(inventory.sourceSHA, source.sourceSHA);
assert.equal(inventory.workflowRef, source.workflowRef);
assert.equal(inventory.workflowRunURL, source.workflowRunURL);
assert.match(
	source.workflowRef,
	/^iuliandita\/ditero\/\.github\/workflows\/aio-experimental\.yml@refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+$/,
);
assert.match(
	source.workflowRunURL,
	/^https:\/\/github\.com\/iuliandita\/ditero\/actions\/runs\/[1-9][0-9]*$/,
);
assert.match(
	inventory.candidate,
	new RegExp(`^aio-experimental-${source.sourceSHA}-[1-9][0-9]*-[1-9][0-9]*$`),
);
assert.deepEqual(inventory.repositories, [
	"ghcr.io/iuliandita/ditero",
	"docker.io/iuliandita/ditero",
]);
assert.match(inventory.indexDigest, /^sha256:[0-9a-f]{64}$/);
for (const key of [
	"indexRegistriesMatch",
	"indexSigned",
	"indexProvenanceAttested",
])
	assert.equal(inventory[key], true);
assert.deepEqual(Object.keys(inventory.platforms).sort(), ["amd64", "arm64"]);
const sourceNames = [
	"deploy/docker/aio/run-bundle.sh",
	"deploy/docker/aio/compose.yml",
	"deploy/docker/aio/README.md",
	"LICENSE",
	"docs/runbooks/deployment-settings.md",
	"docs/runbooks/database-roles.md",
	"docs/runbooks/encryption.md",
];
assert.deepEqual(Object.keys(source.sourceFiles).sort(), sourceNames.sort());
const packaged = new Map();
for (const [name, digest] of Object.entries(source.sourceFiles)) {
	assert.match(digest, /^[0-9a-f]{64}$/);
	assert.equal(hash(packageFile(name)), digest, "package source pin");
	packaged.set(join(packageRoot, name), digest);
}
const expectedMembers = new Set([
	...sourceNames,
	"SOURCE.json",
	"IMAGE-INVENTORY.json",
]);
for (const arch of ["amd64", "arm64"]) {
	const row = inventory.platforms[arch];
	assert.equal(row.sourceSHA, source.sourceSHA);
	assert.equal(row.platform, `linux/${arch}`);
	assert.match(row.digest, /^sha256:[0-9a-f]{64}$/);
	for (const key of [
		"registriesMatch",
		"scanPassed",
		"signed",
		"provenanceAttested",
	])
		assert.equal(row[key], true);
	assert.equal(row.sbom, `sbom-${arch}.spdx.json`);
	assert.match(row.sbomSHA256, /^[0-9a-f]{64}$/);
	const name = `evidence/${row.sbom}`;
	assert.equal(
		hash(packageFile(name)),
		row.sbomSHA256,
		"package platform SBOM pin",
	);
	expectedMembers.add(name);
}
const sums = packageFile("SHA256SUMS");
const covered = new Set();
for (const line of sums.toString("utf8").trimEnd().split("\n")) {
	const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
	assert(
		match && expectedMembers.has(match[2]) && !covered.has(match[2]),
		"exact unique inner checksum member",
	);
	assert.equal(hash(packageFile(match[2])), match[1], "inner package checksum");
	covered.add(match[2]);
	packaged.set(join(packageRoot, match[2]), match[1]);
}
assert.deepEqual(
	[...covered].sort(),
	[...expectedMembers].sort(),
	"complete inner checksum closure",
);
packaged.set(join(packageRoot, "SHA256SUMS"), hash(sums));
const fixture = mkdtempSync(join(tmpdir(), "ditero-aio-wrapper-"));
chmodSync(fixture, 0o700);
const cases = [];
const deadline = Date.now() + 25 * 60_000;
let cleanupDeadline;
let failure;
let imageID;
let cleaning = false;
let interruption;
let exitStatus = 0;
let finalReceipt;
function saveReceipt() {
	if (!finalReceipt) return;
	finalReceipt.interruption = interruption;
	finalReceipt.exitStatus = exitStatus;
	if (failure) finalReceipt.passed = false;
	writeFileSync(
		join(fixture, "receipt.json"),
		JSON.stringify(finalReceipt, null, 2),
		{ mode: 0o600 },
	);
}
const cancellation = new AbortController();
for (const [signal, status] of [
	["SIGTERM", 143],
	["SIGINT", 130],
	["SIGHUP", 143],
]) {
	process.on(signal, () => {
		if (interruption) return;
		interruption = { signal, status };
		if (exitStatus === 0) exitStatus = status;
		process.exitCode = exitStatus;
		failure ??= new Error("fixture interrupted");
		if (!cleaning) cancellation.abort();
		else saveReceipt();
	});
}
function checkCancellation() {
	if (!cleaning && interruption) throw new Error("fixture interrupted");
}
async function pause(ms) {
	checkCancellation();
	await delay(
		ms,
		undefined,
		cleaning ? undefined : { signal: cancellation.signal },
	);
	checkCancellation();
}
function command(
	program,
	args,
	{ input, allowFailure = false, timeout = 30_000, env = process.env } = {},
) {
	checkCancellation();
	const remaining = Math.min(
		timeout,
		(cleanupDeadline ?? deadline) - Date.now(),
	);
	assert(remaining > 0, "fixture deadline");
	const result = spawnSync(program, args, {
		input,
		env,
		encoding: "utf8",
		timeout: remaining,
		maxBuffer: 8 * 1024 * 1024,
	});
	// Runtime output stays private in memory; never print credentials or child logs.
	if (result.error)
		throw new Error(`${program} transport failed: ${result.error.code}`);
	if (!allowFailure) assert.equal(result.status, 0, `${program} status`);
	return result;
}
const docker = (args, options) => command("docker", args, options);
const sudo = (args) => command("sudo", ["-n", ...args]);
const inspect = (id) => JSON.parse(docker(["inspect", id]).stdout)[0];
function samePackage() {
	for (const [path, digest] of packaged)
		assert.equal(hash(readFileSync(path)), digest, "unchanged packaged bytes");
}
function processIdentity(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { pid, state: fields[0], started: fields[19] };
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ESRCH") return null;
		throw error;
	}
}
function processTree(pid) {
	const result = [];
	function visit(parent) {
		let children;
		try {
			children = readFileSync(
				`/proc/${parent}/task/${parent}/children`,
				"utf8",
			).trim();
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ESRCH") return;
			throw error;
		}
		for (const child of children.split(/\s+/).filter(Boolean).map(Number)) {
			const identity = processIdentity(child);
			if (identity) {
				result.push(identity);
				visit(child);
			}
		}
	}
	visit(pid);
	return result;
}
async function until(test, expires, description) {
	while (Date.now() < Math.min(expires, cleanupDeadline ?? deadline)) {
		const value = test();
		if (value) return value;
		await pause(500);
	}
	throw new Error(`${description} deadline`);
}
function compose(c, args, options) {
	samePackage();
	return docker(
		["compose", "--project-name", c.project, "--file", composeFile, ...args],
		{ ...options, env: c.env },
	);
}
function service(c, name, optional = false) {
	const ids = compose(c, ["ps", "--all", "--quiet", name])
		.stdout.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (optional && ids.length === 0) return null;
	assert.equal(ids.length, 1, `exactly one ${name}`);
	const row = inspect(ids[0]);
	assert.equal(row.Config.Labels["com.docker.compose.project"], c.project);
	assert.equal(row.Config.Labels["com.docker.compose.service"], name);
	assert.equal(row.Config.Image, image);
	assert.equal(row.Image, imageID);
	return row;
}
function rows(c) {
	return Object.fromEntries(
		["postgres", "migrate", "api", "zero"].map((name) => [
			name,
			service(c, name, true),
		]),
	);
}
function healthy(c) {
	assert(!c.exit, "wrapper must remain alive through healthy control");
	const all = rows(c);
	for (const name of ["postgres", "api", "zero"]) {
		if (!all[name]) return false;
		assert(
			!["exited", "dead"].includes(all[name].State.Status),
			`${name} exited before readiness`,
		);
	}
	if (all.migrate?.State.Status === "exited")
		assert.equal(all.migrate.State.ExitCode, 0, "migration succeeds");
	return ["postgres", "api", "zero"].every(
		(name) => all[name].State.Health?.Status === "healthy",
	) && all.migrate?.State.Status === "exited"
		? all
		: false;
}
const exec = (id, script, input) =>
	docker(["exec", "-i", id, "/bin/sh", "-ec", script], { input });
function credentials(c, role, uid, values) {
	const dir = join(c.path, `${role}-credentials`);
	mkdirSync(dir, { mode: 0o700 });
	for (const [name, value] of Object.entries(values)) {
		const path = join(dir, name);
		writeFileSync(path, `${value}\n`, { mode: 0o600 });
		c.credentials.push({ path, uid, hash: hash(readFileSync(path)) });
		sudo(["chown", `${uid}:${uid}`, path]);
	}
	sudo(["chown", `${uid}:${uid}`, dir]);
	c.credentialDirs.push(dir);
	return dir;
}
function monitorBudget(source) {
	const value = (pattern, name) => {
		const match = source.match(pattern);
		assert(match, `actual image ${name} contract`);
		return Number(match[1]);
	};
	const interval = value(/intervalMs\s*=\s*(\d+)/, "monitor interval");
	const startup = value(/startupMs\s*=\s*(\d+)/, "startup grace");
	const failures = value(/failureLimit\s*=\s*(\d+)/, "failure threshold");
	const probe = value(
		/probeTimer\s*=\s*setTimeout\([\s\S]*?\b(\d+)\s*,?\s*\);/,
		"probe deadline",
	);
	const stop = value(
		/timer\s*=\s*setTimeout\([\s\S]*?\b(\d+)\s*\);/,
		"child stop deadline",
	);
	assert(interval > 0 && startup > 0 && failures > 0 && probe > 0 && stop > 0);
	return { interval, startup, failures, probe, stop, cycle: interval + probe };
}
function launch(c) {
	samePackage();
	c.child = spawn("/bin/sh", [wrapper], {
		cwd: bundle,
		env: c.env,
		stdio: "ignore",
	});
	c.pid = c.child.pid;
	assert(c.pid, "actual wrapper PID");
	c.child.once("error", () => {
		c.exit = { launchError: true };
	});
	c.child.once("exit", (code, signal) => {
		c.exit = { code, signal };
	});
}
async function stable(c, ms) {
	const expires = Date.now() + ms;
	while (Date.now() < expires) {
		assert(healthy(c), "sustained healthy graph");
		await pause(Math.min(1000, expires - Date.now()));
	}
	assert(healthy(c), "healthy graph at injection");
}
function recordVolumes(c, all) {
	const volumeNames = new Set();
	for (const [name, target] of [
		["postgres", "/var/lib/ditero/pg18"],
		["api", "/var/lib/ditero/attachments"],
		["zero", "/var/lib/ditero/zero"],
	]) {
		const mount = all[name].Mounts.find(
			(m) => m.Type === "volume" && m.Destination === target,
		);
		assert(mount, `${name} volume`);
		assert(c.volumes.includes(mount.Name), "rendered owned volume");
		volumeNames.add(mount.Name);
		const source =
			name === "postgres"
				? `${target}/data/PG_VERSION`
				: `${target}/aio-wrapper-sentinel`;
		const bytes =
			name === "postgres"
				? exec(all[name].Id, `cat ${source}`).stdout
				: randomBytes(32).toString("hex");
		if (name !== "postgres")
			exec(all[name].Id, `umask 077; cat > ${source}`, bytes);
		c.sentinels.push({ id: all[name].Id, source, hash: hash(bytes) });
	}
	assert.equal(volumeNames.size, 3);
}
function retained(c) {
	for (const name of c.volumes) {
		const row = JSON.parse(docker(["volume", "inspect", name]).stdout)[0];
		assert.equal(row.Labels["com.docker.compose.project"], c.project);
	}
	for (let i = 0; i < c.sentinels.length; i++) {
		const entry = c.sentinels[i];
		const target = join(c.path, `retained-sentinel-${i}`);
		docker(["cp", `${entry.id}:${entry.source}`, target]);
		assert.equal(
			hash(readFileSync(target)),
			entry.hash,
			"retained volume bytes after graph shutdown",
		);
		rmSync(target);
	}
	for (const entry of c.credentials) {
		assert.equal(
			command("sudo", ["-n", "sha256sum", entry.path]).stdout.split(/\s+/)[0],
			entry.hash,
			"retained credential bytes",
		);
		assert.equal(
			command("sudo", [
				"-n",
				"stat",
				"-c",
				"%u:%g:%a",
				entry.path,
			]).stdout.trim(),
			`${entry.uid}:${entry.uid}:600`,
		);
	}
}
async function stopped(c, budget) {
	await until(() => c.exit, Date.now() + budget, "wrapper exit");
	assert.equal(c.exit.signal, null, "wrapper handles signal itself");
	for (const identity of c.composeChildren) {
		const actual = processIdentity(identity.pid);
		assert(
			!actual || actual.started !== identity.started,
			"Compose child is reaped, including descendants",
		);
	}
	for (const [name, row] of Object.entries(rows(c))) {
		assert(row, `${name} retained container`);
		assert.equal(row.State.Running, false, `${name} sibling stopped`);
	}
	retained(c);
	samePackage();
}
async function runCase(kind) {
	const project = `ditero-aio-wrapper-${randomBytes(8).toString("hex")}`;
	const c = {
		kind,
		project,
		path: join(fixture, project),
		credentials: [],
		credentialDirs: [],
		sentinels: [],
		admitted: false,
		passed: false,
	};
	cases.push(c);
	mkdirSync(c.path, { mode: 0o700 });
	const secret = () => randomBytes(32).toString("hex");
	const pg = {
		POSTGRES_PASSWORD: secret(),
		DITERO_MIGRATION_DB_PASSWORD: secret(),
		DITERO_RUNTIME_DB_PASSWORD: secret(),
		ZERO_DATABASE_PASSWORD: secret(),
	};
	c.env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		DITERO_AIO_IMAGE: image,
		DITERO_AIO_PROJECT: project,
		AIO_APP_PORT: "0",
		AIO_ZERO_PORT: "0",
		AIO_POSTGRES_SECRETS: credentials(c, "postgres", 1001, pg),
		AIO_MIGRATE_SECRETS: credentials(c, "migrate", 1000, {
			DITERO_MIGRATION_DB_PASSWORD: pg.DITERO_MIGRATION_DB_PASSWORD,
		}),
		AIO_API_SECRETS: credentials(c, "api", 1000, {
			DITERO_RUNTIME_DB_PASSWORD: pg.DITERO_RUNTIME_DB_PASSWORD,
			BETTER_AUTH_SECRET: secret(),
			DITERO_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		}),
		AIO_ZERO_SECRETS: credentials(c, "zero", 1002, {
			ZERO_DATABASE_PASSWORD: pg.ZERO_DATABASE_PASSWORD,
			ZERO_ADMIN_PASSWORD: secret(),
		}),
		BETTER_AUTH_URL: "http://localhost:3000",
		PUBLIC_ZERO_URL: "http://localhost:4848",
	};
	const config = JSON.parse(compose(c, ["config", "--format", "json"]).stdout);
	assert.deepEqual(Object.keys(config.services).sort(), [
		"api",
		"migrate",
		"postgres",
		"zero",
	]);
	for (const role of Object.values(config.services))
		assert.equal(role.image, image);
	for (const name of ["api", "zero"])
		for (const port of config.services[name].ports)
			assert.equal(String(port.published), "0");
	c.volumes = Object.values(config.volumes).map((v) => v.name);
	assert.equal(c.volumes.length, 3);
	for (const volume of Object.values(config.volumes)) {
		assert(
			!volume.external && volume.name.startsWith(`${project}_`),
			"fresh project-scoped volume",
		);
	}
	for (const network of Object.values(config.networks)) {
		assert(
			!network.external && network.name.startsWith(`${project}_`),
			"fresh project-scoped network",
		);
	}
	assert.equal(compose(c, ["ps", "--all", "--quiet"]).stdout.trim(), "");
	for (const name of c.volumes) {
		const result = docker(["volume", "inspect", name], { allowFailure: true });
		assert.notEqual(result.status, 0);
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
	);
	c.admitted = true;
	launch(c);
	const all = await until(
		() => healthy(c),
		Date.now() + 300_000,
		"fresh graph readiness",
	);
	const source = exec(
		all.api.Id,
		"cat /usr/local/lib/ditero-aio/config.mjs",
	).stdout;
	c.monitor = monitorBudget(source);
	c.monitorSourceSHA256 = hash(source);
	await stable(
		c,
		kind === "health"
			? c.monitor.startup + 2 * c.monitor.cycle
			: c.monitor.cycle,
	);
	recordVolumes(c, all);
	c.composeChildren = processTree(c.pid);
	assert(
		c.composeChildren.length > 0,
		"actual foreground Compose child exists",
	);
	if (kind === "TERM" || kind === "HUP") {
		assert(c.child.kill(`SIG${kind}`), "signal only actual wrapper PID");
		await stopped(c, 4 * 30_000 + c.monitor.stop + c.monitor.cycle);
		assert.equal(c.exit.code, 143, `wrapper-only ${kind} status`);
	} else {
		const injected = exec(
			all.api.Id,
			'children=$(cat /proc/1/task/1/children); set -- $children; test $# -eq 1; guardian=$1; target=; for child in $(cat /proc/$guardian/task/$guardian/children); do executable=$(readlink /proc/$child/exe 2>/dev/null || true); if [ "$executable" = /usr/local/bin/bun ]; then test -z "$target"; target=$child; fi; done; test -n "$target"; kill -STOP "$target"; kill -0 "$target"; attempt=0; while :; do state=$(awk \'/^State:/ {print $2}\' /proc/$target/status); [ "$state" = T ] && break; attempt=$((attempt+1)); test "$attempt" -lt 20; sleep 0.05; done; printf "%s\\n" "$target"',
		).stdout.trim();
		assert.match(injected, /^\d+$/);
		c.stoppedEssentialPID = Number(injected);
		const probe = docker(
			[
				"exec",
				all.api.Id,
				"curl",
				"-fsS",
				"--max-time",
				"2",
				"--noproxy",
				"*",
				"http://127.0.0.1:3000/health",
			],
			{ allowFailure: true, timeout: 5000 },
		);
		assert.notEqual(probe.status, 0, "live stopped child is unresponsive");
		assert(
			inspect(all.api.Id).State.Running,
			"guardian survives initial unresponsive probe",
		);
		const expires =
			Date.now() +
			c.monitor.failures * c.monitor.cycle +
			c.monitor.stop +
			4 * 30_000;
		await stopped(c, expires - Date.now());
		assert(
			Number.isInteger(c.exit.code) && c.exit.code !== 0,
			"health failure propagates to wrapper",
		);
		const api = service(c, "api");
		assert.notEqual(
			api.State.ExitCode,
			0,
			"sustained API health failure exits guardian nonzero",
		);
		const logs = docker(["logs", "--tail", "100", api.Id]);
		assert(
			(logs.stdout + logs.stderr).includes("sustained role health failure"),
			"actual health monitor caused guardian failure",
		);
	}
	c.passed = true;
	console.log(`PASS packaged wrapper ${kind}`);
}
try {
	const row = JSON.parse(docker(["image", "inspect", image]).stdout)[0];
	assert(
		row.RepoDigests.includes(image),
		"already loaded exact registry digest; no implicit pull",
	);
	assert.equal(row.Os, "linux", "loaded platform OS");
	assert(
		["amd64", "arm64"].includes(row.Architecture),
		"inventory platform architecture",
	);
	assert.equal(
		row.Config.Labels["org.opencontainers.image.revision"],
		source.sourceSHA,
		"loaded image source revision",
	);
	assert.equal(
		row.Config.Labels["ditero.channel"],
		"aio-experimental",
		"published experimental image channel",
	);
	const repository = image.slice(0, image.lastIndexOf("@"));
	const selectedDigest = image.slice(image.lastIndexOf("@") + 1);
	assert(
		inventory.repositories.includes(repository),
		"approved package registry",
	);
	const platformDigest = inventory.platforms[row.Architecture].digest;
	assert(
		selectedDigest === inventory.indexDigest ||
			selectedDigest === platformDigest,
		"image digest belongs to exact package platform/index",
	);
	const platform = JSON.parse(
		docker(["image", "inspect", `${repository}@${platformDigest}`]).stdout,
	)[0];
	assert(
		platform.RepoDigests.includes(`${repository}@${platformDigest}`),
		"already loaded exact package platform digest",
	);
	assert.equal(
		platform.Id,
		row.Id,
		"selected index resolves to the package platform bytes",
	);
	imageID = row.Id;
	assert.match(imageID, /^sha256:[0-9a-f]{64}$/);
	for (const kind of ["TERM", "HUP", "health"]) await runCase(kind);
} catch (error) {
	failure ??= error;
	if (exitStatus === 0) exitStatus = 1;
	console.error(
		"Packaged wrapper lifecycle qualification failed; runtime output withheld",
	);
} finally {
	cleaning = true;
	cleanupDeadline = Date.now() + 5 * 60_000;
	for (const c of cases) {
		try {
			if (c.child && !c.exit) {
				c.composeChildren ??= processTree(c.pid);
				c.child.kill("SIGTERM");
				try {
					await until(
						() => c.exit,
						Date.now() + 150_000,
						"cleanup wrapper exit",
					);
				} catch {
					c.wrapperCleanupFailed = true;
					failure ??= new Error("wrapper cleanup deadline");
					if (exitStatus === 0) exitStatus = 1;
					// Only the exact still-owned child handle is escalated, never a PID search.
					c.child.kill("SIGKILL");
					await until(() => c.exit, Date.now() + 5000, "owned wrapper reap");
				}
			}
			if (c.admitted) {
				const owned = docker([
					"ps",
					"--all",
					"--quiet",
					"--filter",
					`label=com.docker.compose.project=${c.project}`,
				])
					.stdout.trim()
					.split(/\s+/)
					.filter(Boolean)
					.map(inspect);
				for (const row of owned) {
					assert.equal(
						row.Config.Labels["com.docker.compose.project"],
						c.project,
					);
					assert(
						["postgres", "migrate", "api", "zero"].includes(
							row.Config.Labels["com.docker.compose.service"],
						),
					);
					assert.equal(row.Config.Image, image);
					assert.equal(row.Image, imageID);
				}
				compose(c, ["down", "--timeout", "30"], { timeout: 150_000 });
				assert.equal(
					docker([
						"ps",
						"--all",
						"--quiet",
						"--filter",
						`label=com.docker.compose.project=${c.project}`,
					]).stdout.trim(),
					"",
				);
				assert.equal(
					docker([
						"network",
						"ls",
						"--quiet",
						"--filter",
						`label=com.docker.compose.project=${c.project}`,
					]).stdout.trim(),
					"",
				);
			}
			c.cleanupPassed = !c.wrapperCleanupFailed;
		} catch {
			c.cleanupPassed = false;
			failure ??= new Error("exact project cleanup failed; volumes retained");
			if (exitStatus === 0) exitStatus = 1;
		}
	}
	// Validate every retained volume before removing any; failed qualification keeps all volumes.
	if (
		!failure &&
		cases.length === 3 &&
		cases.every((c) => c.passed && c.cleanupPassed)
	) {
		try {
			for (const c of cases)
				for (const name of c.volumes) {
					const row = JSON.parse(docker(["volume", "inspect", name]).stdout)[0];
					assert.equal(row.Labels["com.docker.compose.project"], c.project);
				}
			for (const c of cases) {
				c.removedVolumes = [];
				for (const name of c.volumes) {
					docker(["volume", "rm", name]);
					c.removedVolumes.push(name);
				}
			}
		} catch {
			failure ??= new Error(
				"scoped volume cleanup failed; remaining volumes retained",
			);
			if (exitStatus === 0) exitStatus = 1;
		}
	}

	// Failed credentials and volumes remain private for exact scoped recovery.
	try {
		if (!failure)
			for (const c of cases) {
				for (const path of [
					...c.credentials.map((v) => v.path),
					...c.credentialDirs,
				])
					sudo(["chown", `${process.getuid()}:${process.getgid()}`, path]);
			}
		if (!failure) for (const c of cases) rmSync(c.path, { recursive: true });
	} catch {
		failure ??= new Error("private fixture cleanup failed");
		if (exitStatus === 0) exitStatus = 1;
	}
	// Deliver pending signals before recording the final cleanup outcome.
	await delay(0);
	const passed =
		!failure &&
		cases.length === 3 &&
		cases.every((c) => c.passed && c.cleanupPassed);
	finalReceipt = {
		passed,
		image,
		imageID,
		sourceSHA: source.sourceSHA,
		interruption,
		exitStatus,
		packagedSHA256: Object.fromEntries(packaged),
		cases: cases.map((c) => ({
			kind: c.kind,
			project: c.project,
			passed: c.passed,
			cleanupPassed: c.cleanupPassed,
			wrapperCleanupFailed: c.wrapperCleanupFailed,
			monitor: c.monitor,
			monitorSourceSHA256: c.monitorSourceSHA256,
			wrapperPID: c.pid,
			wrapperExit: c.exit,
			composeChildren: c.composeChildren,
			stoppedEssentialPID: c.stoppedEssentialPID,
			volumes: c.volumes,
			retainedVolumes: c.volumes?.filter(
				(name) => !c.removedVolumes?.includes(name),
			),
		})),
	};
	saveReceipt();
	if (passed)
		console.log(`Packaged wrapper receipt: ${join(fixture, "receipt.json")}`);
	else
		console.error(`Private fixture retained for scoped recovery: ${fixture}`);
}
if (failure && exitStatus === 0) exitStatus = 1;
process.exitCode = exitStatus;
