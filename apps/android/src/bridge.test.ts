import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	bridgeState,
	completeOnce,
	connectBridge,
	createNativePush,
	type Hello,
	NativeWebSocket,
	readBridgeState,
	readConfig,
	revokeSession,
	setNativeSessionRefusalHandler,
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

test("only confirmed current socket refusal removes native authority", async () => {
	snapshot.session = session;
	await connectBridge();
	await readConfig();
	const ended = vi.fn();
	setNativeSessionRefusalHandler(snapshot.gen, session.authHandle, ended);
	const socket = new NativeWebSocket(
		"wss://zero.example.test/sync/v51/connect",
		"opaque",
	);
	const command = [...sent].reverse().find((entry) => entry.op === "ws.open");
	if (!command) throw new Error("socket open was not posted");
	reply(command, { ok: false, cid: command.cid, code: "http-401" });
	expect(bridgeState().session?.userId).toBe("user-1");
	expect(ended).not.toHaveBeenCalled();
	const current = new NativeWebSocket(
		"wss://zero.example.test/sync/v51/connect",
		"opaque",
	);
	const open = [...sent].reverse().find((entry) => entry.op === "ws.open");
	if (!open) throw new Error("socket open was not posted");
	reply(open, { ok: false, cid: open.cid, code: "unauthorized" });
	expect(bridgeState().session).toBeNull();
	expect(ended).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(0);
	expect(current.readyState).toBe(NativeWebSocket.CLOSED);
	expect(socket.readyState).toBe(NativeWebSocket.CLOSED);
	snapshot = {
		...snapshot,
		gen: 2,
		session: { ...session, authHandle: "opaque-2" },
	};
	await readBridgeState();
	const nextEnded = vi.fn();
	setNativeSessionRefusalHandler(2, "opaque-2", nextEnded);
	current.nativeReply(false, open.rid, "unauthorized");
	expect(bridgeState().session?.authHandle).toBe("opaque-2");
	expect(nextEnded).not.toHaveBeenCalled();
});

test("stale-request refusal reaches only the current same-session page", async () => {
	snapshot = {
		...snapshot,
		gen: 2,
		session: { ...session, authHandle: "current-page" },
	};
	await connectBridge();
	const ended = vi.fn();
	setNativeSessionRefusalHandler(2, "current-page", ended);
	const emit = (gen: number, authHandle: string) =>
		native.onmessage?.(
			new MessageEvent("message", {
				data: JSON.stringify({ t: "session-refused", gen, authHandle }),
			}),
		);
	emit(1, "current-page");
	emit(2, "replaced-session");
	expect(bridgeState().session?.authHandle).toBe("current-page");
	expect(ended).not.toHaveBeenCalled();
	emit(2, "current-page");
	expect(bridgeState().session).toBeNull();
	expect(ended).toHaveBeenCalledTimes(1);
	emit(2, "current-page");
	expect(ended).toHaveBeenCalledTimes(1);
});

test("push uses only fixed account-bound operations and validates every state", async () => {
	snapshot.session = session;
	await connectBridge();
	const push = createNativePush(1, session.authHandle);
	for (const [method, op] of [
		["read", "push.state"],
		["enable", "push.enable"],
		["disable", "push.disable"],
		["permission", "push.permission"],
	] as const) {
		const result = push[method]();
		const command = sent.at(-1);
		if (!command) throw new Error("missing push command");
		expect(command).toEqual({
			op,
			id: session.authHandle,
			gen: 1,
			rid: expect.any(Number),
		});
		reply(command, {
			state: "cleanup-pending",
			permission: "granted",
			provider: "unifiedpush",
		});
		expect(await result).toEqual({
			state: "cleanup-pending",
			permission: "granted",
			provider: "unifiedpush",
		});
	}
	for (const fields of [
		{ state: "active", permission: "denied", provider: "unifiedpush" },
		{ state: "unknown", permission: "granted", provider: "unifiedpush" },
		{ state: "active", permission: "granted", provider: "google" },
		{ state: "active", permission: true, provider: "unifiedpush" },
	]) {
		const result = push.read();
		const refused = expect(result).rejects.toMatchObject({
			code: "invalid-reply",
		});
		const command = sent.at(-1);
		if (!command) throw new Error("missing push command");
		reply(command, fields);
		await refused;
	}
});

test("push cannot post for a retired account or accept its late result", async () => {
	snapshot.session = session;
	await connectBridge();
	const push = createNativePush(1, session.authHandle);
	const pendingPush = push.enable();
	const refused = expect(pendingPush).rejects.toMatchObject({
		code: "stale-generation",
	});
	const command = sent.at(-1);
	if (!command) throw new Error("missing push command");
	snapshot = {
		...snapshot,
		gen: 2,
		session: { ...session, authHandle: "opaque-2" },
	};
	await readBridgeState();
	reply(command, {
		state: "active",
		permission: "granted",
		provider: "unifiedpush",
	});
	await refused;
	const before = sent.length;
	await expect(push.read()).rejects.toMatchObject({ code: "stale-generation" });
	expect(sent).toHaveLength(before);
});
