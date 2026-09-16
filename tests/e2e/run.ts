import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const compose = [
	"compose",
	"--project-name",
	"ditero-e2e",
	"--file",
	"tests/e2e/docker-compose.yml",
];
const databaseURL = "postgres://postgres:pass@localhost:55432/ditero_e2e";
const env = {
	...process.env,
	DATABASE_URL: databaseURL,
	E2E_DATABASE_URL: databaseURL,
	NODE_ENV: "test",
};

const isolatedBrowser = process.env.E2E_BROWSER_CONTAINER === "1";
if (isolatedBrowser) {
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
	Object.assign(env, {
		PW_TEST_CONNECT_WS_ENDPOINT: "ws://127.0.0.1:53000/",
		PW_TEST_CONNECT_EXPOSE_NETWORK: "<loopback>",
	});
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

let status = 1;
try {
	// The api servers import src/paraglide (generated, gitignored) at boot, and
	// they start before vite -- whose paraglide plugin would otherwise be the
	// only thing generating it.
	await run("bun", ["run", "i18n:compile"]);
	await run("docker", [...compose, "up", "--detach", "--wait", "upstream-db"]);
	await run("bun", ["run", "db:migrate"]);
	await run("docker", [
		...compose,
		"up",
		"--build",
		"--detach",
		"--wait",
		"zero-cache",
	]);
	if (isolatedBrowser)
		await run("docker", [
			...compose,
			"--profile",
			"browser",
			"up",
			"--detach",
			"--wait",
			"browser",
		]);
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
	const cleanup = await run(
		"docker",
		[
			...compose,
			"--profile",
			"browser",
			"down",
			"--volumes",
			"--remove-orphans",
		],
		true,
	).catch((error) => {
		console.error(error);
		return 1;
	});
	if (status === 0) status = cleanup;
}

if (interrupted) status = interrupted === "SIGINT" ? 130 : 143;
process.exit(status);
