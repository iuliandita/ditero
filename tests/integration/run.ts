import { spawnSync } from "node:child_process";

const compose = [
	"compose",
	"--project-name",
	"ditero-integration",
	"--file",
	"tests/e2e/docker-compose.yml",
];
const databaseURL = "postgres://postgres:pass@localhost:55432/ditero_e2e";
const requestedTests = process.argv.slice(2);
const s3Test = "tests/integration/s3-store.test.ts";
const env = {
	...process.env,
	DATABASE_URL: databaseURL,
	NODE_ENV: "test",
	DITERO_REGISTRATION_MODE: "bootstrap",
	BETTER_AUTH_SECRET: "integration-only-better-auth-secret",
	BETTER_AUTH_URL: "http://localhost:3000",
	DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
	S3_ACCESS_KEY_ID: "minioadmin",
	S3_SECRET_ACCESS_KEY: "minioadmin",
	S3_BUCKET: "ditero-test",
	S3_ENDPOINT: "http://localhost:59000",
	S3_REGION: "us-east-1",
};

function run(command: string, args: string[], allowFailure = false) {
	const result = spawnSync(command, args, { env, stdio: "inherit" });
	if (!allowFailure && result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status}`);
	}
	return result.status ?? 1;
}

function runVitest(filters: string[], bunRuntime = false): number {
	return run(
		"bunx",
		[
			...(bunRuntime ? ["--bun"] : []),
			"vitest",
			"run",
			"--no-file-parallelism",
			...filters,
		],
		true,
	);
}

let status = 1;
try {
	run("docker", [
		...compose,
		"up",
		"--detach",
		"--wait",
		"upstream-db",
		"minio",
	]);
	run("docker", [...compose, "run", "--rm", "minio-init"]);
	run("bun", ["run", "db:migrate"]);
	if (requestedTests.length === 0) {
		const existingStatus = runVitest([
			"tests/integration",
			"--exclude",
			s3Test,
		]);
		const s3Status = runVitest([s3Test], true);
		status = existingStatus || s3Status;
	} else {
		status = runVitest(
			requestedTests,
			requestedTests.length === 1 && requestedTests[0]?.includes("s3-store"),
		);
	}
} finally {
	run("docker", [...compose, "down", "--volumes", "--remove-orphans"], true);
}

process.exit(status);
