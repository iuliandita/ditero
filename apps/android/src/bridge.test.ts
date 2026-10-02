import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	bridgeState,
	completeOnce,
	connectBridge,
	type Hello,
	NativeWebSocket,
	readBridgeState,
	readConfig,
	revokeSession,
} from "./bridge.ts";

const origin = "https://example.test";
const session = {
	scope: `native:${JSON.stringify([origin, "user-1"])}`,
	userId: "user-1",
	deviceId: "device-1",
	authHandle: "opaque-1",
	expiresAt: "2030-01-01T00:00:00Z",
	tokenReady: true,
	jwtExp: 2000000000,
};
let snapshot: Hello & {
	exchanging: boolean;
	revoking: boolean;
	grantPending: boolean;
};
let sent: Record<string, unknown>[];
let native: {
	postMessage(message: string): void;
	onmessage: ((event: MessageEvent) => void) | null;
};
function reply(
	command: Record<string, unknown>,
	fields: Record<string, unknown>,
) {
	native.onmessage?.(
		new MessageEvent("message", {
			data: JSON.stringify({
				t: "reply",
				rid: command.rid,
				ok: true,
				...fields,
			}),
		}),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	sent = [];
	snapshot = {
		gen: 1,
		server: {
			origin,
			queryUrl: `${origin}/api/zero/query`,
			mutateUrl: `${origin}/api/zero/mutate`,
		},
		session: null,
		exchanging: false,
		revoking: false,
		grantPending: true,
	};
	native = {
		onmessage: null,
		postMessage(message) {
			const command = JSON.parse(message) as Record<string, unknown>;
			sent.push(command);
			if (command.op === "hello" || command.op === "state.read")
				reply(command, { ...snapshot });
			else if (command.op === "config.read")
				reply(command, {
					...snapshot.server,
					zeroURL: "https://zero.example.test",
				});
			else if (command.op === "complete") {
				snapshot.exchanging = true;
				setTimeout(() => {
					snapshot = {
						...snapshot,
						session,
						exchanging: false,
						grantPending: false,
					};
					reply(command, { state: "signed-in", session });
				}, 45000);
			} else if (command.op === "session.revoke") {
				snapshot.revoking = true;
				setTimeout(() => {
					snapshot = { ...snapshot, session: null, revoking: false };
					reply(command, { remoteRevoked: true });
				}, 45000);
			}
		},
	};
	vi.stubGlobal("NativeDitero", native);
	vi.stubGlobal(
		"CloseEvent",
		class extends Event {
			constructor(
				type: string,
				readonly detail: CloseEventInit,
			) {
				super(type);
			}
		},
	);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("Finish reconciles a late successful exchange without starting another grant or exchange", async () => {
	await connectBridge();
	const first = completeOnce();
	await vi.advanceTimersByTimeAsync(30000);
	expect(await first).toBe("finishing");
	expect(await completeOnce()).toBe("finishing");
	await vi.advanceTimersByTimeAsync(15000);
	expect(await completeOnce()).toEqual(session);
	expect(bridgeState().session).toEqual(session);
	expect(sent.filter((command) => command.op === "complete")).toHaveLength(1);
	expect(sent.filter((command) => command.op === "grant")).toHaveLength(0);
});

test("late revocation reconciles local sign-out without claiming proven remote revocation", async () => {
	snapshot.session = session;
	await connectBridge();
	const first = revokeSession();
	const refused = expect(first).rejects.toMatchObject({ code: "revoking" });
	await vi.advanceTimersByTimeAsync(30000);
	await refused;
	expect(bridgeState().session).toEqual(session);
	await vi.advanceTimersByTimeAsync(15000);
	expect(await revokeSession()).toEqual({
		authorityAbsent: true,
		localCleared: false,
		remote: "unknown",
	});
	expect(bridgeState().session).toBeNull();
	expect(
		sent.filter((command) => command.op === "session.revoke"),
	).toHaveLength(1);
});

test("snapshots retain sockets, UTF-8 oversized sends are refused, and native rejected sends terminate", async () => {
	snapshot.session = session;
	await connectBridge();
	await readConfig();
	const socket = new NativeWebSocket(
		"wss://zero.example.test/sync",
		"opaque-protocol",
	);
	const open = sent.at(-1);
	if (!open) throw new Error("missing socket command");
	socket.nativeEvent({ e: "open" });
	await vi.advanceTimersByTimeAsync(0);
	expect(socket.readyState).toBe(NativeWebSocket.OPEN);
	expect((await readBridgeState()).changed).toBe(false);
	expect(socket.readyState).toBe(NativeWebSocket.OPEN);
	expect(() => socket.send("é".repeat(524289))).toThrow(
		"native frame too large",
	);
	expect(socket.readyState).toBe(NativeWebSocket.CLOSED);
	expect(sent.filter((command) => command.op === "ws.send")).toHaveLength(0);
	const next = new NativeWebSocket(
		"wss://zero.example.test/sync",
		"opaque-protocol",
	);
	next.nativeEvent({ e: "open" });
	await vi.advanceTimersByTimeAsync(0);
	next.send('["ping",{}]');
	const send = sent.at(-1);
	if (!send) throw new Error("missing send command");
	reply(send, { ok: false, cid: send.cid, code: "not-open" });
	expect(next.readyState).toBe(NativeWebSocket.CLOSED);
});
