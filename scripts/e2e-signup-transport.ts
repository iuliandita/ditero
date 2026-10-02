import { errorMonitor } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ProxyOptions } from "vite";

type Source = "incoming" | "downstream" | "outgoing" | "upstream" | "proxy";
type Event =
	| "start"
	| "aborted"
	| "error"
	| "finish"
	| "close"
	| "request"
	| "response"
	| "end"
	| "econnreset";

export const configureSignupTransport: NonNullable<
	ProxyOptions["configure"]
> = (proxy) => {
	if (
		process.env.NODE_ENV !== "test" ||
		process.env.DITERO_E2E_SIGNUP_TRANSPORT !== "1"
	)
		return;
	let ordinal = 0;
	let sequence = 0;
	let socketOrdinal = 0;
	const sockets = new WeakMap<Socket, { id: number; requests: number }>();
	const started = performance.now();
	const requests = new WeakMap<
		IncomingMessage,
		(
			source: Source,
			event: Event,
			error?: unknown,
			reusedSocket?: boolean,
		) => void
	>();
	proxy.on("start", (req: IncomingMessage, res: ServerResponse) => {
		const socket = req.socket;
		let socketState = sockets.get(socket);
		if (!socketState) {
			socketState = { id: ++socketOrdinal, requests: 0 };
			sockets.set(socket, socketState);
			const socketRecord = (
				event: "end" | "close" | "error",
				error?: unknown,
			) => {
				const code =
					error && typeof error === "object" && "code" in error
						? error.code
						: undefined;
				console.warn(
					"[e2e-signup-transport]",
					JSON.stringify({
						sequence: ++sequence,
						timeMs: performance.now() - started,
						wallTime: new Date().toISOString(),
						pid: process.pid,
						role: "vite-proxy",
						source: "incoming-socket",
						event,
						socket: sockets.get(socket)?.id,
						destroyed: socket.destroyed,
						bytesRead: socket.bytesRead,
						bytesWritten: socket.bytesWritten,
						code:
							typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
								? code
								: undefined,
					}),
				);
			};
			socket.on("end", () => socketRecord("end"));
			socket.on("close", () => socketRecord("close"));
			socket.on(errorMonitor, (error) => socketRecord("error", error));
		}
		const priorRequests = socketState.requests++;
		if (
			req.method !== "POST" ||
			req.url?.split("?", 1)[0] !== "/api/auth/sign-up/email"
		)
			return;
		const request = ++ordinal;

		const value = req.headers["x-ditero-e2e-transport-id"];
		const correlation =
			typeof value === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				value,
			)
				? value
				: undefined;
		const record = (
			source: Source,
			event: Event,
			error?: unknown,
			reusedSocket?: boolean,
		) => {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			console.warn(
				"[e2e-signup-transport]",
				JSON.stringify({
					request,
					correlation,
					sequence: ++sequence,
					wallTime: new Date().toISOString(),
					pid: process.pid,
					role: "vite-proxy",
					socket: socketState.id,
					priorRequests,
					bytesRead: socket.bytesRead,
					bytesWritten: socket.bytesWritten,
					timeMs: performance.now() - started,
					source,
					event,
					code:
						typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
							? code
							: undefined,
					destroyed: req.socket.destroyed,
					headersSent: res.headersSent,
					writableFinished: res.writableFinished,
					reusedSocket,
				}),
			);
		};
		requests.set(req, record);
		record("incoming", "start");
		// Monitoring preserves the stream's existing unhandled-error behavior.
		req.on(errorMonitor, (error) => record("incoming", "error", error));
		req.on("aborted", () => record("incoming", "aborted"));
		res.on("finish", () => record("downstream", "finish"));
		res.on("close", () => {
			if (!res.writableFinished) record("downstream", "close");
		});
	});
	proxy.on("proxyReq", (outgoing, req) => {
		const record = requests.get(req);
		if (!record) return;
		record("outgoing", "request", undefined, outgoing.reusedSocket);
		outgoing.on(errorMonitor, (error) =>
			record("outgoing", "error", error, outgoing.reusedSocket),
		);
	});
	proxy.on("proxyRes", (upstream, req) => {
		const record = requests.get(req);
		if (!record) return;
		record("upstream", "response");
		upstream.on(errorMonitor, (error) => record("upstream", "error", error));
		upstream.on("aborted", () => record("upstream", "aborted"));
		upstream.on("end", () => record("upstream", "end"));
	});
	proxy.on("error", (error, req) =>
		requests.get(req)?.("proxy", "error", error),
	);
	proxy.on("econnreset", (error, req) =>
		requests.get(req)?.("proxy", "econnreset", error),
	);
};
