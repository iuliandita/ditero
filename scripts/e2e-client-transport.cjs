const { channel } = require("node:diagnostics_channel");
const { errorMonitor } = require("node:events");

if (
	process.env.NODE_ENV === "test" &&
	process.env.DITERO_E2E_SIGNUP_TRANSPORT === "1"
) {
	const requests = new WeakMap();
	const sockets = new WeakMap();
	let requestOrdinal = 0;
	let socketOrdinal = 0;
	let sequence = 0;
	const started = performance.now();
	const uuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	const record = (event, fields = {}) => {
		console.warn(
			"[e2e-client-transport]",
			JSON.stringify({
				sequence: ++sequence,
				timeMs: performance.now() - started,
				wallTime: new Date().toISOString(),
				pid: process.pid,
				role: "browser-api-client",
				event,
				...fields,
			}),
		);
	};
	const code = (error) =>
		typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
			? error.code
			: undefined;
	const socketFields = (socket) => ({
		socket: sockets.get(socket)?.id,
		destroyed: socket.destroyed,
		bytesRead: socket.bytesRead,
		bytesWritten: socket.bytesWritten,
	});
	record("activated");
	channel("http.client.request.start").subscribe(({ request }) => {
		if (requests.has(request)) return;
		const value = request.getHeader("X-Ditero-E2E-Transport-ID");
		const state = {
			id: ++requestOrdinal,
			correlation:
				typeof value === "string" && uuid.test(value) ? value : undefined,
		};
		requests.set(request, state);
		const emit = (event, error) =>
			record(event, {
				request: state.id,
				correlation: state.correlation,
				priorRequests: state.priorRequests,
				reusedSocket: request.reusedSocket,
				code: code(error),
				...(request.socket ? socketFields(request.socket) : {}),
			});
		const assigned = (socket) => {
			let entry = sockets.get(socket);
			if (!entry) {
				entry = { id: ++socketOrdinal, requests: 0 };
				sockets.set(socket, entry);
				const socketRecord = (event, error) =>
					record(event, { ...socketFields(socket), code: code(error) });
				socket.on("connect", () => socketRecord("socket-connect"));
				socket.on("end", () => socketRecord("socket-end"));
				socket.on("close", (hadError) =>
					record("socket-close", { ...socketFields(socket), hadError }),
				);
				socket.on(errorMonitor, (error) => socketRecord("socket-error", error));
			}
			state.priorRequests = entry.requests++;
			record("socket-assigned", {
				request: state.id,
				correlation: state.correlation,
				priorRequests: state.priorRequests,
				reusedSocket: request.reusedSocket,
				...socketFields(socket),
			});
		};
		// Node publishes request.start after socket assignment on current runtimes.
		if (request.socket) assigned(request.socket);
		else request.once("socket", assigned);
		emit("request-start");
		request.on(errorMonitor, (error) => emit("request-error", error));
		request.on("finish", () => emit("request-finish"));
		request.on("close", () => emit("request-close"));
		request.on("response", () => emit("request-response"));
	});
}
