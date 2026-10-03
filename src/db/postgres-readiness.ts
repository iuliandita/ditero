import { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";

const recoverable = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EAI_AGAIN",
	"EPIPE",
	"57P03",
]);
export function postgresReadinessCode(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[A-Z0-9_]+$/.test(error.code)
	)
		return error.code;
	return "UNKNOWN";
}
function failure(code: string): Error & { code: string } {
	return Object.assign(
		new Error(`PostgreSQL readiness probe failed (${code})`),
		{ code },
	);
}
export async function waitForPostgres(
	connectionString: string,
	options: {
		timeoutMs?: number;
		attemptTimeoutMs?: number;
		backoffMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const attemptTimeoutMs = options.attemptTimeoutMs ?? 2_000;
	const backoffMs = options.backoffMs ?? 200;
	if (
		![timeoutMs, attemptTimeoutMs, backoffMs].every(Number.isSafeInteger) ||
		timeoutMs < 1 ||
		timeoutMs > 30_000 ||
		attemptTimeoutMs < 1 ||
		backoffMs < 1
	)
		throw new Error("Invalid PostgreSQL readiness budget");
	const deadline = performance.now() + timeoutMs;
	let first: Error | undefined;
	for (;;) {
		if (options.signal?.aborted) throw failure("ABORT_ERR");
		const remaining = deadline - performance.now();
		if (remaining <= 0)
			throw new Error("PostgreSQL readiness deadline exceeded", {
				cause: first,
			});
		const socket = new Socket();
		// Register before pg can synchronously throw from Socket.connect.
		const closed = new Promise<void>((resolve) =>
			socket.once("close", resolve),
		);
		socket.on("error", () => {});
		const abort = () => socket.destroy(failure("ABORT_ERR"));
		const timer = setTimeout(
			() => socket.destroy(failure("ETIMEDOUT")),
			Math.min(attemptTimeoutMs, remaining),
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		let error: unknown;
		try {
			const client = new Client({ connectionString, stream: () => socket });
			if (
				!Number.isInteger(client.port) ||
				client.port < 1 ||
				client.port > 65535
			)
				throw failure("ERR_SOCKET_BAD_PORT");
			// pg emits errors outside a pending connect/query; the owned socket still closes below.
			client.on("error", () => {});
			await client.connect();
			await client.query("select 1");
		} catch (caught) {
			error = caught;
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			socket.destroy();
			// Destroying the owned transport closes pg even if its end listener was never attached.
			await closed;
		}
		if (options.signal?.aborted) throw failure("ABORT_ERR");
		if (error === undefined && performance.now() < deadline) return;
		const code =
			error === undefined ? "ETIMEDOUT" : postgresReadinessCode(error);
		const safe = failure(code);
		first ??= safe;
		if (!recoverable.has(code)) throw safe;
		const delay = Math.min(backoffMs, deadline - performance.now());
		if (delay <= 0)
			throw new Error("PostgreSQL readiness deadline exceeded", {
				cause: first,
			});
		await sleep(delay, undefined, { signal: options.signal }).catch(() => {
			throw failure("ABORT_ERR");
		});
	}
}
