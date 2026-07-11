import { spawnSync } from "node:child_process";

const compose = [
	"compose",
	"--project-name",
	"ditero-integration",
	"--file",
	"tests/e2e/docker-compose.yml",
];
const databaseURL = "postgres://postgres:pass@localhost:55432/ditero_e2e";
const env = {
	...process.env,
	DATABASE_URL: databaseURL,
	NODE_ENV: "test",
	DITERO_REGISTRATION_MODE: "bootstrap",
	BETTER_AUTH_SECRET: "integration-only-better-auth-secret",
	BETTER_AUTH_URL: "http://localhost:3000",
	DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
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
	run("docker", [...compose, "up", "--detach", "--wait", "upstream-db"]);
	run("bun", ["run", "db:migrate"]);
	status = run(
		"bunx",
		["vitest", "run", "--no-file-parallelism", "tests/integration"],
		true,
	);
} finally {
	run("docker", [...compose, "down", "--volumes", "--remove-orphans"], true);
}

process.exit(status);
