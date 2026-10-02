import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { Pool } from "pg";
import { migrate } from "../scripts/migrate.ts";

const name = `ditero-relay-test-${randomBytes(8).toString("hex")}`;
const image = process.env.RELAY_TEST_IMAGE;
const smokeOnly = process.env.RELAY_TEST_SMOKE_ONLY === "1";
const serviceName = `${name}-service`;
let serviceContainerCreated = false;
const directory = await mkdtemp(join(tmpdir(), "ditero-relay-"));
const password = randomBytes(32).toString("hex");
const runtimePassword = randomBytes(32).toString("hex");
let created = false;
async function command(args: string[], capture = false): Promise<string> {
	const process = Bun.spawn(args, {
		stdout: capture ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const output = capture ? await new Response(process.stdout).text() : "";
	if ((await process.exited) !== 0)
		throw new Error("Relay fixture command failed");
	return output.trim();
}
try {
	const envFile = join(directory, "postgres.env");
	await writeFile(
		envFile,
		`POSTGRES_DB=relay
POSTGRES_PASSWORD=${password}
`,
		{ mode: 0o600 },
	);
	await command(
		[
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
		],
		true,
	);
	created = true;
	const binding = await command(["docker", "port", name, "5432/tcp"], true);
	const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
	if (!match) throw new Error("Relay fixture port is not loopback");
	const url = `postgres://postgres:${password}@127.0.0.1:${match[1]}/relay`;
	const runtimeUrl = `postgres://relay_runtime:${runtimePassword}@127.0.0.1:${match[1]}/relay`;
	const admin = new Pool({
		connectionString: url,
		connectionTimeoutMillis: 500,
		max: 1,
	});
	try {
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				await admin.query("SELECT 1");
				ready = true;
				break;
			} catch {
				await Bun.sleep(250);
			}
		}
		if (!ready) throw new Error("Owned relay fixture did not become ready");
		await admin.query(
			`CREATE ROLE relay_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
		);
		await admin.query("REVOKE CREATE ON DATABASE relay FROM PUBLIC");
		await migrate(url, "relay_runtime");
	} finally {
		await admin.end();
	}
	const keys = await generateKeyPair("ES256", { extractable: true });
	const privateJwk = await exportJWK(keys.privateKey);
	const publicJwk = await exportJWK(keys.publicKey);
	const configFile = join(directory, "configuration.json");
	await writeFile(
		configFile,
		JSON.stringify({
			origin: "https://relay.example.org",
			projectNumber: "123456789",
			projectId: "relay-fixture",
			appIds: ["1:123456789:android:abcdef"],
			clientEmail: "fixture@relay-fixture.iam.gserviceaccount.com",
			privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
				.privateKey.export({ type: "pkcs8", format: "pem" })
				.toString(),
			encryptionKey: randomBytes(32).toString("base64"),
			receiptKey: { ...privateJwk, kid: "fixture-key" },
			receiptVerificationKeys: [{ ...publicJwk, kid: "fixture-key" }],
		}),
		{ mode: 0o600 },
	);
	const allocator = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("port"),
	});
	const servicePort = allocator.port;
	await allocator.stop();
	let service: ReturnType<typeof Bun.spawn> | undefined;
	if (image) {
		if (process.platform !== "linux")
			throw new Error("Image relay smoke requires Linux host networking");
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		if (!uid || gid === undefined)
			throw new Error("Image relay smoke requires a nonroot host user");
		const serviceEnv = join(directory, "service.env");
		await writeFile(
			serviceEnv,
			`RELAY_CONFIGURATION_FILE=/run/relay-configuration.json\nRELAY_DATABASE_URL=${runtimeUrl}\nPORT=${servicePort}\n`,
			{ mode: 0o600 },
		);
		await command(
			[
				"docker",
				"run",
				"--detach",
				"--name",
				serviceName,
				"--network",
				"host",
				"--user",
				`${uid}:${gid}`,
				"--env-file",
				serviceEnv,
				"--mount",
				`type=bind,source=${configFile},target=/run/relay-configuration.json,readonly`,
				image,
			],
			true,
		);
		serviceContainerCreated = true;
	} else {
		service = Bun.spawn(["bun", "run", "apps/push-relay/src/index.ts"], {
			env: {
				...process.env,
				RELAY_CONFIGURATION_FILE: configFile,
				RELAY_DATABASE_URL: runtimeUrl,
				PORT: String(servicePort),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
	}
	let serviceError: unknown;
	let shutdownError: Error | undefined;
	try {
		let ready = false;
		for (let attempt = 0; attempt < 80; attempt++) {
			try {
				const alive = await fetch(`http://127.0.0.1:${servicePort}/healthz`, {
					signal: AbortSignal.timeout(1000),
				});
				const available = await fetch(
					`http://127.0.0.1:${servicePort}/readyz`,
					{ signal: AbortSignal.timeout(2500) },
				);
				if (
					alive.status === 200 &&
					available.status === 200 &&
					((await alive.json()) as { status: string }).status === "ok" &&
					((await available.json()) as { status: string }).status === "ready"
				) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(50);
		}
		if (!ready) throw new Error("Shipped Bun relay did not become ready");
		const control = new Pool({ connectionString: url, max: 1 });
		try {
			await control.query(
				"REVOKE SELECT ON relay_schema_version FROM relay_runtime",
			);
			const alive = await fetch(`http://127.0.0.1:${servicePort}/healthz`, {
				signal: AbortSignal.timeout(1000),
			});
			const unavailable = await fetch(
				`http://127.0.0.1:${servicePort}/readyz`,
				{ signal: AbortSignal.timeout(2500) },
			);
			if (alive.status !== 200 || unavailable.status !== 503)
				throw new Error(
					"Relay did not distinguish liveness from database readiness",
				);
		} finally {
			await control.query(
				"GRANT SELECT ON relay_schema_version TO relay_runtime",
			);
			await control.end();
		}
		console.info(
			image
				? "Built relay image health/readiness smoke passed"
				: "Host Bun relay health/readiness smoke passed",
		);
	} catch (error) {
		serviceError = error;
	} finally {
		if (serviceContainerCreated) {
			await command(["docker", "stop", "--time", "5", serviceName], true);
			const state = JSON.parse(
				await command(
					["docker", "inspect", "--format", "{{json .State}}", serviceName],
					true,
				),
			) as { Running: boolean; ExitCode: number };
			if (state.Running || state.ExitCode !== 0)
				shutdownError = new Error(
					"Built relay image did not shut down cleanly",
				);
		} else if (service) {
			service.kill("SIGTERM");
			const stopped = await Promise.race([
				service.exited,
				Bun.sleep(5000).then(() => null),
			]);
			if (stopped === null) {
				service.kill("SIGKILL");
				await service.exited;
				shutdownError = new Error("Host relay did not shut down");
			} else if (stopped !== 0) {
				const stderr = service.stderr;
				const errors =
					!stderr || typeof stderr === "number"
						? ""
						: await new Response(stderr).text();
				shutdownError = new Error(
					`Host relay failed: ${errors.slice(0, 2000)}`,
				);
			}
		}
		if (!shutdownError)
			console.info(
				image
					? "Built relay image graceful shutdown passed"
					: "Host Bun relay graceful shutdown passed",
			);
	}
	if (serviceError) throw serviceError;
	if (shutdownError) throw shutdownError;
	if (!smokeOnly) {
		const run = Bun.spawn(
			[
				"bunx",
				"vitest",
				"run",
				"apps/push-relay/tests/integration.test.ts",
				"--no-file-parallelism",
			],
			{
				env: {
					...process.env,
					RELAY_TEST_DATABASE_URL: runtimeUrl,
					RELAY_TEST_ADMIN_DATABASE_URL: url,
				},
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const exitCode = await run.exited;
		if (exitCode !== 0) process.exitCode = exitCode;
	}
} finally {
	if (serviceContainerCreated)
		await command(["docker", "rm", "--force", "--volumes", serviceName], true);
	if (created)
		await command(["docker", "rm", "--force", "--volumes", name], true);
	await rm(directory, { recursive: true, force: true });
}
