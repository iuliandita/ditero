import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, expect, test } from "vitest";
import { waitForPostgres } from "../../src/db/postgres-readiness.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const target = new URL(databaseURL);
const admin = new Client({ connectionString: databaseURL });
await admin.connect();
afterAll(async () => {
	await admin.end();
});
async function proxy(
	mode: "forward" | "stall" | "no-tls" | "starting" | "query-stall",
	port = 0,
) {
	const sockets = new Set<Socket>();
	let connections = 0;
	const server = createServer((socket) => {
		connections++;
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		if (mode === "stall") {
			// Consume bytes so the server observes the probe's FIN rather than a paused readable.
			socket.resume();
			return;
		}
		if (mode === "starting" && connections === 1) {
			socket.once("data", () => {
				const fields = Buffer.from("SFATAL\0C57P03\0Mdatabase is starting\0\0");
				const frame = Buffer.alloc(5);
				frame[0] = 69;
				frame.writeInt32BE(fields.length + 4, 1);
				socket.end(Buffer.concat([frame, fields]));
			});
			return;
		}
		if (mode === "no-tls") {
			socket.once("data", () => socket.end("N"));
			return;
		}
		const upstream = connect(Number(target.port || 5432), target.hostname);
		sockets.add(upstream);
		upstream.on("error", () => socket.destroy());
		upstream.on("close", () => {
			sockets.delete(upstream);
			socket.destroy();
		});
		socket.on("close", () => upstream.destroy());
		if (mode === "query-stall") {
			socket.on("data", (chunk) => {
				if (chunk[0] !== 81) upstream.write(chunk);
			});
			upstream.pipe(socket);
		} else socket.pipe(upstream).pipe(socket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing proxy port");
	const url = new URL(target);
	url.hostname = "127.0.0.1";
	url.port = String(address.port);
	return {
		url: url.toString(),
		port: address.port,
		connections: () => connections,
		sockets,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
test("migration waits for a late-bound database and executes no DDL before readiness", async () => {
	const initialSchema = (
		await admin.query("select to_regnamespace('drizzle') as schema")
	).rows[0].schema;
	const reserved = await proxy("forward");
	const url = reserved.url,
		port = reserved.port;
	await reserved.close();
	const child = spawn("bun", ["run", "src/db/migrate.ts"], {
		env: { ...process.env, DATABASE_URL: url },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.stdout.resume();
	const ended = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	let forwarding: Awaited<ReturnType<typeof proxy>> | undefined;
	try {
		await delay(700);
		expect(child.exitCode, stderr.replaceAll(url, "[database]")).toBeNull();
		expect(
			(await admin.query("select to_regnamespace('drizzle') as schema")).rows[0]
				.schema,
		).toBe(initialSchema);
		forwarding = await proxy("forward", port);
		expect(await ended).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as n from drizzle.__drizzle_migrations",
				)
			).rows[0].n,
		).toBeGreaterThan(0);
		expect(forwarding.connections()).toBeGreaterThanOrEqual(2);
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await ended;
		await forwarding?.close();
	}
}, 40_000);
test("connection refusal recovers after a listener is bound", async () => {
	const reservation = await proxy("forward");
	const url = reservation.url,
		port = reservation.port;
	await reservation.close();
	const pending = waitForPostgres(url, {
		timeoutMs: 1500,
		attemptTimeoutMs: 200,
		backoffMs: 30,
	});
	await delay(100);
	const forwarding = await proxy("forward", port);
	try {
		await pending;
		expect(forwarding.connections()).toBe(1);
	} finally {
		await forwarding.close();
	}
});
test("PostgreSQL 57P03 retries before a real successful probe", async () => {
	const starting = await proxy("starting");
	try {
		await waitForPostgres(starting.url, { timeoutMs: 1500, backoffMs: 10 });
		expect(starting.connections()).toBe(2);
	} finally {
		await starting.close();
	}
});
test("an authenticated but stalled query is terminated and its sockets are closed", async () => {
	const stalled = await proxy("query-stall");
	try {
		await expect(
			waitForPostgres(stalled.url, {
				timeoutMs: 250,
				attemptTimeoutMs: 80,
				backoffMs: 10,
			}),
		).rejects.toMatchObject({ cause: { code: "ETIMEDOUT" } });
		await delay(20);
		expect(stalled.sockets.size).toBe(0);
	} finally {
		await stalled.close();
	}
});
test("a stalled handshake exhausts a bounded budget and closes every owned socket", async () => {
	const stalled = await proxy("stall");
	const start = performance.now();
	try {
		await expect(
			waitForPostgres(stalled.url, {
				timeoutMs: 250,
				attemptTimeoutMs: 80,
				backoffMs: 10,
			}),
		).rejects.toMatchObject({ cause: { code: "ETIMEDOUT" } });
		expect(performance.now() - start).toBeLessThan(1000);
		await delay(20);
		expect(stalled.sockets.size).toBe(0);
		expect(stalled.connections()).toBeGreaterThan(1);
	} finally {
		await stalled.close();
	}
});
test("abort destroys an in-flight handshake without waiting for its timeout", async () => {
	const stalled = await proxy("stall"),
		controller = new AbortController();
	const pending = waitForPostgres(stalled.url, { signal: controller.signal });
	await delay(30);
	controller.abort();
	try {
		await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR" });
		await delay(20);
		expect(stalled.sockets.size).toBe(0);
	} finally {
		await stalled.close();
	}
});
test("a real restricted LOGIN probe succeeds but a wrong password fails once without leaking credentials", async () => {
	const role = `readiness_${randomUUID().replaceAll("-", "")}`,
		password = randomBytes(24).toString("hex");
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nobypassrls`,
	);
	const url = new URL(databaseURL);
	url.username = role;
	url.password = password;
	try {
		await waitForPostgres(url.toString());
		const client = new Client({ connectionString: url.toString() });
		await client.connect();
		try {
			expect(
				(
					await client.query(
						"select session_user,current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
					)
				).rows[0],
			).toEqual({
				session_user: role,
				current_user: role,
				rolsuper: false,
				rolbypassrls: false,
			});
		} finally {
			await client.end();
		}
		url.password = `${password}wrong`;
		const forwarding = await proxy("forward");
		const wrong = new URL(forwarding.url);
		wrong.username = role;
		wrong.password = url.password;
		try {
			const start = performance.now();
			const error: unknown = await waitForPostgres(wrong.toString()).catch(
				(caught: unknown) => caught,
			);
			expect(error).toMatchObject({
				code: "28P01",
			});
			expect(String(error)).not.toContain(password);
			expect(JSON.stringify(error)).not.toContain(wrong.toString());
			expect(performance.now() - start).toBeLessThan(1500);
			expect(forwarding.connections()).toBe(1);
		} finally {
			await forwarding.close();
		}
	} finally {
		await admin.query(`drop role "${role}"`);
	}
});
test("TLS refusal fails immediately and closes the probe", async () => {
	const refusal = await proxy("no-tls"),
		url = new URL(refusal.url);
	url.searchParams.set("sslmode", "verify-full");
	try {
		await expect(waitForPostgres(url.toString())).rejects.toMatchObject({
			code: "UNKNOWN",
		});
		expect(refusal.connections()).toBe(1);
		await delay(20);
		expect(refusal.sockets.size).toBe(0);
	} finally {
		await refusal.close();
	}
});
test("invalid URLs fail without retry or publishing the connection string", async () => {
	const secret = "postgres://user:private-password@[invalid";
	try {
		await waitForPostgres(secret);
		throw new Error("Expected URL refusal");
	} catch (error) {
		expect(String(error)).not.toContain("private-password");
		expect(error).toMatchObject({ code: "ERR_INVALID_URL" });
	}
});
test("a malformed query port refuses within its budget in a bounded child process", async () => {
	const url = new URL(databaseURL);
	url.searchParams.set("port", "invalid");
	const code = `import {waitForPostgres} from "./src/db/postgres-readiness.ts";
const guard=setTimeout(()=>process.exit(99),1000);
try {await waitForPostgres(process.env.READINESS_BAD_URL,{timeoutMs:100}); process.exitCode=1;}
catch(error) {console.log(JSON.stringify({code:error.code,message:String(error)}));}
finally {clearTimeout(guard);}`;
	const child = spawn("bun", ["--eval", code], {
		env: { ...process.env, READINESS_BAD_URL: url.toString() },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "",
		stderr = "";
	child.stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const ended = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	try {
		expect(await ended).toBe(0);
		expect(JSON.parse(output)).toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
		expect(output + stderr).not.toContain(url.toString());
		expect(stderr).toBe("");
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		await ended;
	}
}, 3000);
