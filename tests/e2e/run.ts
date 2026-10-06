import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { e2eDatabaseURL } from "../../scripts/e2e-database-port.ts";
import {
	allocatePorts,
	assertDistinctPorts,
	assertEmptyInventory,
	bindEphemeral,
	type CleanupStep,
	cleanupSteps,
	confirmIdentity,
	emptyInventory,
	FULL_ID,
	hostEnvironment,
	type Inventory,
	inspectArgv,
	listArgv,
	loopbackPort,
	mergeOwned,
	newRun,
	originFor,
	ownedInventory,
	PROJECT_LABEL,
	parseIds,
	parseRecords,
	planCleanup,
	RUN_LABEL,
	VOLUME_NAME,
} from "../../scripts/e2e-stack.ts";
import { privateHost } from "../support/private-host.ts";

// Each run owns a unique project and marker (io.ditero.e2e.run on every Compose
// resource), so cleanup can prove what it removes instead of trusting a name.
const stackRun = newRun();
const compose = [
	"compose",
	"--project-name",
	stackRun.project,
	"--file",
	"tests/e2e/docker-compose.yml",
];
const databaseURL = "postgres://postgres:pass@localhost:55432/ditero_e2e";
const env: NodeJS.ProcessEnv = {
	...process.env,
	E2E_DIAGNOSTIC_COMPOSE_ARGV: JSON.stringify(compose),
	DATABASE_URL: databaseURL,
	E2E_DATABASE_URL: databaseURL,
	NODE_ENV: "test",
	DITERO_E2E_SIGNUP_TRANSPORT:
		process.env.DITERO_E2E_SIGNUP_TRANSPORT ?? (process.env.CI ? "1" : "0"),
	DITERO_E2E_RUN_ID: stackRun.runId,
	// Docker picks these; the runner discovers the exact loopback bindings.
	DITERO_E2E_DB_PORT: "0",
	DITERO_E2E_BROWSER_PORT: "0",
	DITERO_E2E_ZERO_PORT: "0",
};

const isolatedBrowser = process.env.E2E_BROWSER_CONTAINER === "1";
function configureBrowser() {
	if (process.env.PW_TEST_CONNECT_WS_ENDPOINT)
		throw new Error(
			"E2E_BROWSER_CONTAINER cannot be combined with PW_TEST_CONNECT_WS_ENDPOINT",
		);
	const config = spawnSync(
		"docker",
		[...compose, "--profile", "browser", "config", "--format", "json"],
		{ env, encoding: "utf8" },
	);
	if (config.status !== 0)
		throw new Error(
			config.stderr || "Cannot read browser Compose configuration",
		);
	const image: string = JSON.parse(config.stdout).services.browser.image;
	const imageVersion =
		/^mcr\.microsoft\.com\/playwright:v([\d.]+)-noble@sha256:[a-f0-9]{64}$/.exec(
			image,
		)?.[1];
	const installed = JSON.parse(
		readFileSync(require.resolve("playwright-core/package.json"), "utf8"),
	).version;
	const lock = Bun.JSONC.parse(readFileSync("bun.lock", "utf8")) as {
		packages?: Record<string, unknown[]>;
	};
	if (
		!imageVersion ||
		imageVersion !== installed ||
		lock.packages?.["playwright-core"]?.[0] !== `playwright-core@${installed}`
	)
		throw new Error(
			"Browser image, installed playwright-core, and bun.lock must use the same exact version",
		);
}

let activeChild: ChildProcess | undefined;
let interrupted: NodeJS.Signals | undefined;
let cleaningUp = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		interrupted = signal;
		if (!cleaningUp) activeChild?.kill(signal);
	});
}

async function run(command: string, args: string[], allowFailure = false) {
	if (interrupted && !cleaningUp)
		throw new Error(`Interrupted by ${interrupted}`);
	const result = await new Promise<number>((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: "inherit" });
		activeChild = child;
		child.once("error", reject);
		child.once("close", (code, signal) => {
			activeChild = undefined;
			resolve(
				code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
			);
		});
	});
	if (!allowFailure && result !== 0)
		throw new Error(`${command} exited with status ${result}`);
	return result;
}

// Bounded, synchronous Docker access for ownership reads and cleanup writes.
function docker(what: string, args: string[], timeout = 15_000): string {
	const result = spawnSync("docker", args, {
		env,
		encoding: "utf8",
		timeout,
		killSignal: "SIGKILL",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`docker ${what} failed: ${result.error?.message ?? `exit ${result.status}`}${
				result.stderr ? `: ${result.stderr.trim().slice(0, 500)}` : ""
			}`,
		);
	return result.stdout;
}

function publishedPort(
	service: string,
	containerPort: string,
	profile = false,
) {
	try {
		return loopbackPort(
			docker(`port ${service}`, [
				...compose,
				...(profile ? ["--profile", "browser"] : []),
				"port",
				service,
				containerPort,
			]),
		);
	} catch (error) {
		throw new Error(`Cannot discover the owned E2E ${service} port`, {
			cause: error,
		});
	}
}

// Everything related to this run by project label OR run marker, by exact
// current state -- never by what the runner believes it created.
function readInventory(): Inventory {
	const filters = [
		`${PROJECT_LABEL}=${stackRun.project}`,
		`${RUN_LABEL}=${stackRun.runId}`,
	];
	const pattern = {
		containers: FULL_ID,
		volumes: VOLUME_NAME,
		networks: FULL_ID,
	};
	const inventory = emptyInventory();
	for (const kind of ["containers", "volumes", "networks"] as const) {
		const keys = new Set<string>();
		for (const filter of filters)
			for (const key of parseIds(
				docker(`${kind} list`, listArgv(kind, filter)),
				pattern[kind],
			))
				keys.add(key);
		if (keys.size)
			Object.assign(inventory, {
				[kind]: parseRecords(
					kind,
					docker(`${kind} inspect`, inspectArgv(kind, [...keys])),
				),
			});
	}
	return inventory;
}

let upAttempted = false;
let tracked = emptyInventory();

// Capture identity from what Docker actually created, including after a failed
// or interrupted `up`.
function snapshot() {
	tracked = mergeOwned(
		tracked,
		ownedInventory(readInventory(), stackRun, isolatedBrowser),
	);
}

async function up(args: string[]) {
	upAttempted = true;
	let failed = false;
	let failure: unknown;
	try {
		await run("docker", [...compose, ...args]);
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		snapshot();
	} catch (error) {
		if (!failed) throw error;
		console.error("E2E ownership snapshot failed:", error);
	}
	if (failed) throw failure;
}

function recheck(step: CleanupStep) {
	const [actual] = parseRecords(
		step.kind,
		docker(`${step.label} recheck`, inspectArgv(step.kind, [step.key])),
	);
	confirmIdentity(step.kind, step.record, actual, stackRun, isolatedBrowser);
}

// Removes only validated, rechecked resources by exact ID/name. Never `down`,
// force, `-v`, or orphan removal. Any refusal or failure stops further writes
// and leaves the stack for manual inspection; there is no retry.
function cleanupStack(): number {
	let steps: CleanupStep[];
	try {
		steps = cleanupSteps(
			planCleanup({
				run: stackRun,
				isolatedBrowser,
				upAttempted,
				tracked,
				current: readInventory(),
			}),
		);
	} catch (error) {
		console.error("E2E cleanup refused; nothing was removed:", error);
		console.error(
			`Inspect: docker ps -a --filter label=${RUN_LABEL}=${stackRun.runId}`,
		);
		return 1;
	}
	for (const [index, step] of steps.entries()) {
		try {
			recheck(step);
			docker(step.label, step.argv, step.timeoutMs);
		} catch (error) {
			console.error(
				`E2E cleanup stopped at "${step.label}"; ${steps.length - index} step(s) were not completed:`,
				error,
			);
			console.error(
				`Inspect: docker ps -a --filter label=${RUN_LABEL}=${stackRun.runId}`,
			);
			return 1;
		}
	}
	return 0;
}

function preserveDiagnostics() {
	const args = process.argv.slice(2);
	let output = process.env.E2E_OUTPUT_DIR ?? "test-results";
	if (!process.env.E2E_OUTPUT_DIR)
		for (let i = 0; i < args.length; i++) {
			if (args[i].startsWith("--output=")) output = args[i].slice(9);
			else if (args[i] === "--output" && args[i + 1]) output = args[++i];
		}
	const directory = join(output, "stack-diagnostics");
	mkdirSync(directory, { recursive: true });
	function capture(name: string, commandArgs: string[]) {
		const result = spawnSync("docker", commandArgs, {
			env,
			encoding: "utf8",
			timeout: 15_000,
			killSignal: "SIGKILL",
			maxBuffer: 8 * 1024 * 1024,
		});
		writeFileSync(join(directory, name), result.stdout ?? "");
		if (result.status !== 0 || result.error) {
			const failure = result.error?.message ?? `exit ${result.status}`;
			console.error(`E2E diagnostics ${name} failed: ${failure}`);
			writeFileSync(
				join(directory, `${name}.error.txt`),
				`${failure}\n${result.stderr ?? ""}`,
			);
		}
		return result;
	}
	const project = [...compose, "--profile", "browser"];
	capture("compose.log", [
		...project,
		"logs",
		"--no-color",
		"--timestamps",
		"--tail",
		"1000",
	]);
	// Keep preload activation and earlier socket history before teardown.
	capture("browser-transport.log", [
		...project,
		"logs",
		"--no-color",
		"--timestamps",
		"browser",
	]);
	capture("compose-ps.json", [...project, "ps", "--all", "--format", "json"]);
	const ids = capture("container-ids.txt", [
		...project,
		"ps",
		"--all",
		"--quiet",
	]);
	if (ids.status !== 0 || ids.error) return;
	const containers = ids.stdout.trim().split(/\s+/).filter(Boolean);
	if (containers.length === 0) return;
	// Select state only: full inspect includes process environment and credentials.
	capture("container-state.json", [
		"inspect",
		"--format",
		'{"Id":{{json .Id}},"State":{{json .State}}}',
		...containers,
	]);
	capture("container-resources.json", [
		"stats",
		"--no-stream",
		"--format",
		"{{json .}}",
		...containers,
	]);
}

let status = 1;
try {
	if (isolatedBrowser) configureBrowser();
	// The api servers import src/paraglide (generated, gitignored) at boot, and
	// they start before vite -- whose paraglide plugin would otherwise be the
	// only thing generating it.
	if (env.E2E_BROWSER_MODE === "compiled")
		await run("bun", ["run", "tests/e2e/compiled-web.ts", "validate"]);
	else await run("bun", ["run", "i18n:compile"]);
	// A fresh UUID cannot pre-exist; anything carrying it is not ours to adopt.
	assertEmptyInventory(readInventory(), stackRun);
	await up(["up", "--detach", "--wait", "upstream-db"]);
	const binding = docker("port upstream-db", [
		...compose,
		"port",
		"upstream-db",
		"5432",
	]);
	const databasePort = loopbackPort(binding);
	const actualDatabaseURL = e2eDatabaseURL(binding);
	env.DATABASE_URL = actualDatabaseURL;
	env.E2E_DATABASE_URL = actualDatabaseURL;
	await run("bun", ["run", "db:migrate"]);
	// Reserved while all are held, then released for the servers that bind them.
	// A race with another process fails loudly: reuseExistingServer is false and
	// Vite runs with --strictPort.
	const ntfyHost = privateHost();
	const hostPorts = await allocatePorts(
		[
			{ name: "api", host: "127.0.0.1" },
			{ name: "web", host: "127.0.0.1" },
			{ name: "mail", host: "127.0.0.1" },
			{ name: "smtp", host: "127.0.0.1" },
			{ name: "smtpHttp", host: "127.0.0.1" },
			{ name: "ntfy", host: ntfyHost },
		],
		bindEphemeral,
		[databasePort],
	);
	Object.assign(env, hostEnvironment(hostPorts, ntfyHost));
	await up(["up", "--build", "--detach", "--wait", "zero-cache"]);
	const zeroPort = publishedPort("zero-cache", "4848");
	env.E2E_PUBLIC_ZERO_URL = originFor(zeroPort);
	const dockerPorts: Record<string, number> = {
		database: databasePort,
		zero: zeroPort,
	};
	if (isolatedBrowser) {
		await up(["--profile", "browser", "up", "--detach", "--wait", "browser"]);
		dockerPorts.browser = publishedPort("browser", "3000", true);
	}
	// Docker's ephemeral ports were chosen after the host ports were released.
	assertDistinctPorts({ ...hostPorts, ...dockerPorts });
	// Only an endpoint on the owned browser's actual port is ever used.
	if (isolatedBrowser)
		Object.assign(env, {
			PW_TEST_CONNECT_WS_ENDPOINT: `ws://127.0.0.1:${dockerPorts.browser}/`,
			PW_TEST_CONNECT_EXPOSE_NETWORK: "<loopback>",
		});
	// Forwards filters and flags: `bun run test:e2e crypto-vectors --project=webkit`.
	status = await run(
		"bunx",
		["playwright", "test", ...process.argv.slice(2)],
		true,
	);
} catch (error) {
	console.error(error);
	status = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
} finally {
	cleaningUp = true;
	if (status !== 0)
		try {
			preserveDiagnostics();
		} catch (error) {
			console.error("E2E diagnostics failed:", error);
		}
	const cleanup = cleanupStack();
	if (status === 0) status = cleanup;
}

if (interrupted) status = interrupted === "SIGINT" ? 130 : 143;
process.exit(status);
