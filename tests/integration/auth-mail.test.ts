// Better Auth's mail path end to end: the real handler, a real Postgres and a
// real SMTP server on a real socket.
import { createServer, type Server, type Socket } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";
import type { SinkOptions, SmtpSink } from "../support/smtp-sink.ts";
import { startSmtpSink } from "../support/smtp-sink.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

const SMTP_KEYS = [
	"DITERO_SMTP_HOST",
	"DITERO_SMTP_PORT",
	"DITERO_SMTP_FROM",
	"DITERO_SMTP_ALLOW_INSECURE",
] as const;

const sinks: SmtpSink[] = [];
const blackHoles: Array<() => void> = [];

beforeEach(async () => {
	await db.delete(tables.membership);
	// Before `workspace`, and not optional: a sibling file that seeds list/task
	// rows and leaves them behind makes the workspace delete fail on
	// list_workspace_id_workspace_id_fk. Which file runs first is decided by
	// vitest's sequencer, so this cannot be left to luck.
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.verification);
	await db.delete(tables.user);
	// /request-password-reset is capped at 3/300s per IP; this file makes more.
	await db.delete(tables.rateLimit);
	for (const key of SMTP_KEYS) delete process.env[key];
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const key of SMTP_KEYS) delete process.env[key];
	for (const stop of blackHoles.splice(0)) stop();
	await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

afterAll(async () => {
	await pool.end();
});

async function useSink(options: SinkOptions = {}): Promise<SmtpSink> {
	const started = await startSmtpSink(options);
	sinks.push(started);
	process.env.DITERO_SMTP_HOST = started.host;
	process.env.DITERO_SMTP_PORT = String(started.port);
	process.env.DITERO_SMTP_ALLOW_INSECURE = "true";
	process.env.DITERO_SMTP_FROM = "Ditero <ditero@example.test>";
	return started;
}

// Accepts the TCP connection and then says nothing at all: the SMTP send hangs
// until the transport's own deadline. Any request that waits on a send is
// unmistakable against it.
async function useBlackHoleSmtp(): Promise<void> {
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => sockets.push(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("black hole: no port");
	}
	blackHoles.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	process.env.DITERO_SMTP_HOST = "127.0.0.1";
	process.env.DITERO_SMTP_PORT = String(address.port);
	process.env.DITERO_SMTP_ALLOW_INSECURE = "true";
	process.env.DITERO_SMTP_FROM = "Ditero <ditero@example.test>";
}

function post(path: string, body: unknown): Promise<Response> {
	return handleAuthRequest(
		new Request(`http://localhost:3000${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify(body),
		}),
	);
}

function signup(email: string): Promise<Response> {
	return post("/api/auth/sign-up/email", {
		name: email.split("@")[0],
		email,
		password: "pw-123456",
	});
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function decodeBody(message: string): string {
	return message
		.replace(/=\r\n/g, "")
		.replace(/=([0-9A-F]{2})/g, (_, hex) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
}

describe("verification mail", () => {
	it("is sent when an account is registered", async () => {
		const sink = await useSink();

		const response = await signup("ada@example.test");
		expect(response.status).toBe(200);

		await waitFor(() => sink.messages.length > 0);
		expect(sink.commands).toContainEqual("RCPT TO:<ada@example.test>");
		const message = decodeBody(sink.messages[0]);
		expect(message).toContain("Subject: Confirm your email address");
		expect(message).toContain(
			"http://localhost:3000/api/auth/verify-email?token=",
		);
	});

	it("does not block registration when the send fails, but says so", async () => {
		const sink = await useSink({ replies: { rcpt: "550 5.1.1 no such user" } });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await signup("ada@example.test");
		// Registration is complete and usable: the mail is an extra, and
		// requireEmailVerification is off precisely so it cannot become a gate.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			user: { email: "ada@example.test" },
		});

		await waitFor(() =>
			error.mock.calls.some((call) =>
				String(call[0]).startsWith("auth mail: verify send"),
			),
		);
		expect(sink.messages).toHaveLength(0);
	});
});

describe("with no SMTP configured", () => {
	it("still registers accounts", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const response = await signup("ada@example.test");
		expect(response.status).toBe(200);
		expect(warn).toHaveBeenCalledWith(
			"auth mail: SMTP is not configured, no verify mail sent to ada@example.test",
		);
	});

	it("refuses a password reset instead of pretending mail was sent", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await signup("ada@example.test");

		const response = await post("/api/auth/request-password-reset", {
			email: "ada@example.test",
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "MAIL_NOT_CONFIGURED",
		});
	});
});

describe("password reset is not a user-enumeration oracle", () => {
	it("answers a known and an unknown address identically, neither waiting on SMTP", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await useSink();
		await signup("ada@example.test");
		// Swapped in only now, so the signup above is not the thing that hangs.
		await useBlackHoleSmtp();

		const knownStart = Date.now();
		const known = await post("/api/auth/request-password-reset", {
			email: "ada@example.test",
		});
		const knownMs = Date.now() - knownStart;

		const unknownStart = Date.now();
		const unknown = await post("/api/auth/request-password-reset", {
			email: "nobody@example.test",
		});
		const unknownMs = Date.now() - unknownStart;

		expect(known.status).toBe(unknown.status);
		expect(await known.text()).toBe(await unknown.text());
		// The registered address is the only one that reaches a send. Awaiting it
		// would put an SMTP round trip -- here, the full 15s deadline -- between
		// the two responses, which is the same oracle measured in milliseconds.
		expect(knownMs).toBeLessThan(2_000);
		expect(unknownMs).toBeLessThan(2_000);
		// A reset token was really minted, so the fast path is not "nothing
		// happened": the fixture can tell the two cases apart if the code does.
		const rows = await db.select().from(tables.verification);
		expect(
			rows.some((row) => row.identifier.startsWith("reset-password:")),
		).toBe(true);
	});
});
