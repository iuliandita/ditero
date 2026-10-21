import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	createWriteStream,
	mkdirSync,
	readFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { type Socket, createServer as tcpServer } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";

export const root = process.cwd();
export const state = resolve(
	process.env.RUNNER_TEMP ?? "docs/local/346-desktop-journeys",
	"desktop-journeys",
);
export const evidence = resolve(state, "evidence");
mkdirSync(evidence, { recursive: true });
const children: ChildProcess[] = [];
export function run(command: string, args: string[], env = process.env) {
	const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(
			`${command} failed (${result.status}): ${result.stderr}\n${result.stdout}`,
		);
	return result.stdout.trim();
}
export function background(
	name: string,
	command: string,
	args: string[],
	env = process.env,
) {
	const log = createWriteStream(resolve(evidence, `${name}.log`));
	const child = spawn(command, args, {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.pipe(log);
	child.stderr?.pipe(log);
	child.on("error", (error) => log.write(String(error)));
	children.push(child);
	return child;
}
export async function until<T>(
	label: string,
	check: () => T | Promise<T>,
	seconds = 60,
): Promise<NonNullable<T>> {
	const deadline = Date.now() + seconds * 1000;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value as NonNullable<T>;
		} catch (error) {
			last = error;
		}
		await new Promise((done) => setTimeout(done, 300));
	}
	throw new Error(`${label} timed out${last ? `: ${last}` : ""}`);
}
export async function freePort() {
	const server = tcpServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("missing TCP address");
	await new Promise<void>((done, fail) =>
		server.close((error) => (error ? fail(error) : done())),
	);
	return address.port;
}
export async function proxy(upstream: number) {
	const port = await freePort();
	const log = createWriteStream(resolve(evidence, `https-${port}.log`));
	let server: ReturnType<typeof httpsServer>;
	const sockets = new Set<Socket>();
	async function online() {
		server = httpsServer(
			{
				key: readFileSync(resolve(state, "server.key")),
				cert: readFileSync(resolve(state, "server.crt")),
			},
			(req, res) => {
				const request = httpRequest(
					{
						host: "127.0.0.1",
						port: upstream,
						path: req.url,
						method: req.method,
						headers: req.headers,
					},
					(reply) => {
						log.write(
							`${req.method} ${req.url?.split("?")[0]} ${reply.statusCode}\n`,
						);
						res.writeHead(reply.statusCode ?? 502, reply.headers);
						reply.pipe(res);
					},
				);
				request.on("error", () => {
					res.writeHead(502);
					res.end();
				});
				req.pipe(request);
			},
		);
		server.on("tlsClientError", (error) => log.write(`TLS ${error.message}\n`));
		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});
		server.on("upgrade", (req, socket, head) => {
			const request = httpRequest({
				host: "127.0.0.1",
				port: upstream,
				path: req.url,
				headers: req.headers,
			});
			request.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
				socket.write(
					`HTTP/1.1 ${reply.statusCode} Switching Protocols\r\n${Object.entries(
						reply.headers,
					)
						.map(([key, value]) => `${key}: ${value}`)
						.join("\r\n")}\r\n\r\n`,
				);
				if (upstreamHead.length) socket.write(upstreamHead);
				if (head.length) upstreamSocket.write(head);
				socket.pipe(upstreamSocket);
				upstreamSocket.pipe(socket);
				socket.on("close", () => upstreamSocket.destroy());
				upstreamSocket.on("error", () => socket.destroy());
			});
			request.on("error", () => socket.destroy());
			request.end();
		});
		await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
	}
	async function offline() {
		if (!server.listening) return;
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((done, fail) =>
			server.close((error) => (error ? fail(error) : done())),
		);
	}
	await online();
	return { origin: `https://localhost:${port}`, offline, online };
}
export async function untrustedFixture() {
	let requests = 0;
	const server = httpsServer(
		{
			key: readFileSync(resolve(state, "untrusted.key")),
			cert: readFileSync(resolve(state, "untrusted.crt")),
		},
		(_request, response) => {
			requests++;
			response.writeHead(500);
			response.end();
		},
	);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing TLS address");
	return {
		origin: `https://localhost:${address.port}`,
		requests: () => requests,
		async close() {
			await new Promise<void>((done, fail) =>
				server.close((error) => (error ? fail(error) : done())),
			);
		},
	};
}
export async function stack() {
	const pg = process.env.JOURNEY_PG_BIN;
	if (!pg) throw new Error("JOURNEY_PG_BIN is required");
	const exe = (name: string) =>
		resolve(pg, `${name}${process.platform === "win32" ? ".exe" : ""}`);
	const data = resolve(state, "postgres");
	const port = await freePort();
	run(exe("initdb"), [
		"-D",
		data,
		"-U",
		"postgres",
		"-A",
		"trust",
		"--encoding=UTF8",
		"--no-locale",
	]);
	appendFileSync(
		resolve(data, "postgresql.conf"),
		"\nunix_socket_directories = ''\nwal_level = 'logical'\nmax_replication_slots = 20\nmax_wal_senders = 20\n",
	);
	run(exe("pg_ctl"), [
		"-D",
		data,
		"-l",
		resolve(evidence, "postgres.log"),
		"-o",
		`-p ${port} -h 127.0.0.1`,
		"-w",
		"start",
	]);
	const admin = new Pool({
		connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
	});
	const wal = await admin.query("show wal_level");
	if (wal.rows[0].wal_level !== "logical")
		throw new Error("logical replication is disabled");
	const instances: {
		name: string;
		api: Awaited<ReturnType<typeof proxy>>;
		zero: Awaited<ReturnType<typeof proxy>>;
		pool: Pool;
	}[] = [];
	async function close() {
		for (const child of children.reverse()) child.kill();
		for (const instance of instances) {
			await instance.api.offline();
			await instance.zero.offline();
			await instance.pool.end();
		}
		await admin.end();
		run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
	}
	try {
		for (const name of ["journey_a", "journey_b"]) {
			await admin.query(`create database ${name}`);
			const database = `postgres://postgres@127.0.0.1:${port}/${name}`;
			const apiPort = await freePort(),
				zeroPort = await freePort();
			const api = await proxy(apiPort),
				zero = await proxy(zeroPort);
			const pool = new Pool({ connectionString: database });
			instances.push({ name, api, zero, pool });
			const env = {
				...process.env,
				NODE_ENV: "test",
				DATABASE_URL: database,
				BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
				DITERO_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
				BETTER_AUTH_URL: api.origin,
				DITERO_PUBLIC_URL: api.origin,
				PUBLIC_ZERO_URL: zero.origin,
				API_PORT: String(apiPort),
				SERVE_STATIC_DIR: resolve(root, "dist"),
				DITERO_REGISTRATION_MODE: "open",
				DITERO_BACKGROUND_JOBS: "0",
			};
			run("bun", ["run", "src/db/migrate.ts"], env);
			background(`${name}-api`, "bun", ["run", "src/server/index.ts"], env);
			await until(
				`${name} API`,
				async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok,
			);
			background(
				`${name}-zero`,
				"node",
				[resolve(root, "node_modules/@rocicorp/zero/out/zero/src/cli.js")],
				{
					...env,
					ZERO_PORT: String(zeroPort),
					ZERO_UPSTREAM_DB: database,
					ZERO_CVR_DB: database,
					ZERO_CHANGE_DB: database,
					ZERO_REPLICA_FILE: resolve(state, `${name}.db`),
					ZERO_ADMIN_PASSWORD: randomBytes(32).toString("hex"),
					ZERO_QUERY_URL: `http://127.0.0.1:${apiPort}/api/zero/query`,
					ZERO_MUTATE_URL: `http://127.0.0.1:${apiPort}/api/zero/mutate`,
					ZERO_ENABLE_CRUD_MUTATIONS: "false",
					ZERO_NUM_SYNC_WORKERS: "1",
				},
			);
			await until(
				`${name} Zero`,
				async () => (await fetch(`http://127.0.0.1:${zeroPort}/keepalive`)).ok,
				120,
			);
		}
		return { instances, close };
	} catch (error) {
		await close();
		throw error;
	}
}
