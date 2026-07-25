import { spawnSync } from "node:child_process";

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

function run(command: string, args: string[], allowFailure = false) {
	const result = spawnSync(command, args, { env, stdio: "inherit" });
	if (!allowFailure && result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status}`);
	}
	return result.status ?? 1;
}

let status = 1;
try {
	// The api servers import src/paraglide (generated, gitignored) at boot, and
	// they start before vite -- whose paraglide plugin would otherwise be the
	// only thing generating it.
	run("bun", ["run", "i18n:compile"]);
	run("docker", [...compose, "up", "--detach", "--wait", "upstream-db"]);
	run("bun", ["run", "db:migrate"]);
	run("docker", [...compose, "up", "--detach", "--wait", "zero-cache"]);
	status = run("bunx", ["playwright", "test"], true);
} finally {
	run("docker", [...compose, "down", "--volumes", "--remove-orphans"], true);
}

process.exit(status);
