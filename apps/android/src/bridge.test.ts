import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getLocale } from "../../../src/paraglide/runtime.js";

vi.mock("../../../src/paraglide/runtime.js", () => ({
	getLocale: vi.fn(() => "en"),
}));

import {
	bridgeState,
	completeOnce,
	connectBridge,
	createNativeNotificationNavigation,
	createNativePush,
	createNativeTaskLinkNavigation,
	type Hello,
	NativeWebSocket,
	readBridgeState,
	readConfig,
	revokeSession,
	selectServer,
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
	vi.mocked(getLocale).mockReturnValue("en");
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
		{ state: "active", permission: "granted", provider: "desktop" },
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

test("desktop push sends current locale only to locale-aware operations", async () => {
	snapshot.session = session;
	await connectBridge();
	const push = createNativePush(1, session.authHandle, "desktop");
	expect(push.provider).toBe("desktop");
	for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as const) {
		vi.mocked(getLocale).mockReturnValue(locale);
		for (const [method, op] of [
			["read", "push.state"],
			["enable", "push.enable"],
			["permission", "push.permission"],
			["disable", "push.disable"],
		] as const) {
			const result = push[method]();
			const command = sent.at(-1);
			if (!command) throw new Error("missing push command");
			expect(command).toEqual({
				op,
				id: session.authHandle,
				gen: 1,
				rid: expect.any(Number),
				...(method === "disable" ? {} : { locale }),
			});
			reply(command, {
				state: "unsupported",
				permission: "denied",
				provider: "desktop",
			});
			expect(await result).toEqual({
				state: "unsupported",
				permission: "denied",
				provider: "desktop",
			});
		}
	}
	const result = push.read();
	const refused = expect(result).rejects.toMatchObject({
		code: "invalid-reply",
	});
	const command = sent.at(-1);
	if (!command) throw new Error("missing push command");
	reply(command, {
		state: "active",
		permission: "granted",
		provider: "unifiedpush",
	});
	await refused;
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

test("notification navigation validates fixed targets and rejects caller URLs", async () => {
	snapshot.session = session;
	await connectBridge();
	const navigation = createNativeNotificationNavigation(1, session.authHandle);
	const target = { kind: "task", workspaceId: "w", listId: "l", taskId: "t" };
	for (const open of [
		null,
		{ token: "tap-1", target },
		{ token: "tap-2", target: { kind: "workspace", workspaceId: "w" } },
	]) {
		const result = navigation.read();
		const command = sent.at(-1);
		if (!command) throw new Error("missing command");
		expect(command).toMatchObject({
			op: "push.open",
			id: session.authHandle,
			gen: 1,
		});
		reply(command, { open });
		expect(await result).toEqual(open);
	}
	for (const open of [
		{ token: "tap", target: { ...target, url: "https://evil.test" } },
		{ token: "tap", target: { kind: "task", workspaceId: "w", listId: "l" } },
		{ token: "tap", target: { kind: "workspace", workspaceId: "w/evil" } },
	]) {
		const result = navigation.read();
		const rejected = expect(result).rejects.toMatchObject({
			code: "invalid-reply",
		});
		const command = sent.at(-1);
		if (!command) throw new Error("missing command");
		reply(command, { open });
		await rejected;
	}
});

test("notification events and late targets cannot cross account generations", async () => {
	snapshot.session = session;
	await connectBridge();
	const navigation = createNativeNotificationNavigation(1, session.authHandle);
	const listener = vi.fn();
	const unsubscribe = navigation.subscribe(listener);
	const emit = (gen: number) =>
		native.onmessage?.(
			new MessageEvent("message", {
				data: JSON.stringify({ t: "push.open", gen }),
			}),
		);
	emit(0);
	expect(listener).not.toHaveBeenCalled();
	emit(1);
	expect(listener).toHaveBeenCalledTimes(1);
	const result = navigation.read();
	const rejected = expect(result).rejects.toMatchObject({
		code: "stale-generation",
	});
	const command = sent.at(-1);
	if (!command) throw new Error("missing command");
	snapshot = {
		...snapshot,
		gen: 2,
		session: { ...session, authHandle: "other" },
	};
	await readBridgeState();
	reply(command, {
		open: { token: "tap", target: { kind: "workspace", workspaceId: "w" } },
	});
	await rejected;
	emit(2);
	expect(listener).toHaveBeenCalledTimes(1);
	unsubscribe();
});

test("Google build identity comes from native hello and mismatched push replies are refused", async () => {
	snapshot.session = session;
	snapshot.pushProvider = "google";
	const hello = await connectBridge();
	expect(hello.pushProvider).toBe("google");
	const current = bridgeState();
	expect(current.pushProvider).toBe("google");
	const push = createNativePush(
		current.gen,
		session.authHandle,
		current.pushProvider,
	);
	const result = push.read();
	const command = sent.at(-1);
	if (!command) throw new Error("missing push command");
	reply(command, {
		state: "enabling",
		permission: "granted",
		provider: "google",
	});
	expect(await result).toEqual({
		state: "enabling",
		permission: "granted",
		provider: "google",
	});
	const mismatch = push.read();
	const refused = expect(mismatch).rejects.toMatchObject({
		code: "invalid-reply",
	});
	const next = sent.at(-1);
	if (!next) throw new Error("missing push command");
	reply(next, {
		state: "active",
		permission: "granted",
		provider: "unifiedpush",
	});
	await refused;
});

test("native hello rejects an unknown push provider", async () => {
	native.postMessage = (raw) => {
		const command = JSON.parse(raw) as Record<string, unknown>;
		reply(command, { ...snapshot, pushProvider: "unexpected" });
	};
	await expect(connectBridge()).rejects.toMatchObject({
		code: "invalid-reply",
	});
});

test("bridge snapshots preserve optional task-link capability and refusal flags", async () => {
	for (const enabled of [true, false]) {
		snapshot.taskLinks = enabled;
		snapshot.linkRefused = enabled;
		await connectBridge();
		expect(bridgeState()).toMatchObject({
			taskLinks: enabled,
			linkRefused: enabled,
		});
	}
	delete snapshot.taskLinks;
	delete snapshot.linkRefused;
	await connectBridge();
	expect(Object.hasOwn(bridgeState(), "taskLinks")).toBe(false);
	expect(Object.hasOwn(bridgeState(), "linkRefused")).toBe(false);
});

test("Linux link capability is explicit and unavailable on other native hosts", async () => {
	snapshot.session = session;
	await connectBridge();
	const navigation = createNativeTaskLinkNavigation(1, session.authHandle);
	const before = sent.length;
	await expect(navigation.read()).rejects.toMatchObject({
		code: "stale-generation",
	});
	expect(sent).toHaveLength(before);
});
test("Linux link reads validate task-only identity and exact opaque dismissal", async () => {
	snapshot.session = session;
	snapshot.taskLinks = true;
	await connectBridge();
	const navigation = createNativeTaskLinkNavigation(1, session.authHandle);
	for (const open of [
		null,
		{ token: "link", taskId: "task" },
		{ token: "refused", taskId: null },
	]) {
		const result = navigation.read();
		const command = sent.at(-1);
		if (!command) throw Error("missing command");
		expect(command).toMatchObject({
			op: "link.read",
			id: session.authHandle,
			gen: 1,
		});
		reply(command, { open });
		expect(await result).toEqual(open);
	}
	const dismiss = navigation.dismiss("link");
	const command = sent.at(-1);
	if (!command) throw Error("missing command");
	expect(command).toMatchObject({
		op: "link.dismiss",
		id: session.authHandle,
		body: { token: "link" },
	});
	reply(command, {});
	await dismiss;
	const before = sent.length;
	await expect(navigation.dismiss("../file")).rejects.toMatchObject({
		code: "invalid-message",
	});
	expect(sent).toHaveLength(before);
});
test("Linux link reply cannot grant URL, workspace, or mutation authority", async () => {
	snapshot.session = session;
	snapshot.taskLinks = true;
	await connectBridge();
	const navigation = createNativeTaskLinkNavigation(1, session.authHandle);
	for (const open of [
		{ token: "link", taskId: ".." },
		{ token: "link", taskId: "task", url: "https://evil.test" },
		{ token: "link", taskId: "task", workspaceId: "w" },
		{ token: "link", taskId: 7 },
		{ token: "link", taskId: "a".repeat(129) },
		{ token: "link/evil", taskId: "task" },
	]) {
		const result = navigation.read();
		const refused = expect(result).rejects.toMatchObject({
			code: "invalid-reply",
		});
		const command = sent.at(-1);
		if (!command) throw Error("missing command");
		reply(command, { open });
		await refused;
	}
});
test("Linux link events and asynchronous reads cannot cross accounts", async () => {
	snapshot.session = session;
	snapshot.taskLinks = true;
	await connectBridge();
	const navigation = createNativeTaskLinkNavigation(1, session.authHandle);
	const listener = vi.fn();
	const unsubscribe = navigation.subscribe(listener);
	const emit = (gen: number) =>
		native.onmessage?.(
			new MessageEvent("message", {
				data: JSON.stringify({ t: "link.open", gen }),
			}),
		);
	emit(0);
	emit(1);
	expect(listener).toHaveBeenCalledTimes(1);
	const result = navigation.read();
	const refused = expect(result).rejects.toMatchObject({
		code: "stale-generation",
	});
	const command = sent.at(-1);
	if (!command) throw Error("missing command");
	snapshot = {
		...snapshot,
		gen: 2,
		session: { ...session, authHandle: "other" },
	};
	await readBridgeState();
	reply(command, { open: { token: "link", taskId: "task" } });
	await refused;
	emit(2);
	expect(listener).toHaveBeenCalledTimes(1);
	const before = sent.length;
	await expect(navigation.dismiss("link")).rejects.toMatchObject({
		code: "stale-generation",
	});
	expect(sent).toHaveLength(before);
	unsubscribe();
});

test("a fresh hello after server.select rebinds the page and old navigation cannot consume the new link", async () => {
	// Fake native protocol: select clears the slot and fences, reads never lift the fence, and only
	// a hello binds the parked link to a new generation and account handle.
	const first = { ...session, authHandle: "opaque-select" };
	const second = { ...session, authHandle: "opaque-hello" };
	let fenced = false;
	let hold = false;
	let hellos = 0;
	let pending: { token: string; taskId: string } | null = {
		token: "old",
		taskId: "old-task",
	};
	const dismissed: string[] = [];
	native.postMessage = (raw) => {
		const command = JSON.parse(raw) as Record<string, unknown>;
		sent.push(command);
		if (command.op === "server.select") {
			fenced = true;
			pending = null;
			snapshot = { ...snapshot, gen: 2, session: first, taskLinks: true };
			reply(command, { ...snapshot });
		} else if (command.op === "hello") {
			if (++hellos > 1) {
				fenced = false;
				pending = { token: "new", taskId: "new-task" };
				snapshot = { ...snapshot, gen: 3, session: second, taskLinks: true };
			}
			reply(command, { ...snapshot });
		} else if (command.op === "link.read") {
			if (!hold) reply(command, { open: fenced ? null : pending });
		} else if (command.op === "link.dismiss") {
			const body = command.body as { token: string };
			if (pending?.token === body.token) {
				dismissed.push(body.token);
				pending = null;
			}
			reply(command, {});
		}
	};
	snapshot.session = session;
	snapshot.taskLinks = true;
	await connectBridge();
	const stale = createNativeTaskLinkNavigation(1, session.authHandle);
	expect(await stale.read()).toEqual(pending);

	await selectServer(origin);
	expect(bridgeState()).toMatchObject({ gen: 2 });
	const selected = createNativeTaskLinkNavigation(2, first.authHandle);
	expect(await selected.read()).toBeNull();
	expect(fenced).toBe(true);
	hold = true;
	const inflight = selected.read();
	const dropped = expect(inflight).rejects.toMatchObject({
		code: "stale-generation",
	});

	await connectBridge();
	await dropped;
	hold = false;
	expect(fenced).toBe(false);
	expect(bridgeState()).toMatchObject({
		gen: 3,
		session: { authHandle: second.authHandle },
	});

	const before = sent.length;
	for (const navigation of [stale, selected]) {
		await expect(navigation.read()).rejects.toMatchObject({
			code: "stale-generation",
		});
		await expect(navigation.dismiss("new")).rejects.toMatchObject({
			code: "stale-generation",
		});
	}
	expect(sent).toHaveLength(before);
	expect(pending).toEqual({ token: "new", taskId: "new-task" });
	expect(dismissed).toEqual([]);

	const current = createNativeTaskLinkNavigation(3, second.authHandle);
	expect(await current.read()).toEqual({ token: "new", taskId: "new-task" });
	await current.dismiss("new");
	expect(dismissed).toEqual(["new"]);
});

test("Linux link retirement waits for a captured-account acknowledgement and fails explicitly", async () => {
	snapshot.session = session;
	snapshot.taskLinks = true;
	await connectBridge();
	const navigation = createNativeTaskLinkNavigation(1, session.authHandle);
	const first = navigation.retire();
	const command = sent.at(-1);
	if (!command) throw Error("missing command");
	expect(command).toMatchObject({
		op: "link.retire",
		id: session.authHandle,
		gen: 1,
	});
	expect(command).not.toHaveProperty("body");
	reply(command, { ok: false, code: "busy" });
	await expect(first).rejects.toMatchObject({ code: "busy" });
	const retry = navigation.retire();
	const next = sent.at(-1);
	if (!next) throw Error("missing command");
	reply(next, {});
	await retry;
	expect(bridgeState().session).toEqual(session);
});

test("archive export capability survives verified host metadata snapshots", async () => {
	snapshot.archiveExport = true;
	expect((await connectBridge()).archiveExport).toBe(true);
	expect(bridgeState().archiveExport).toBe(true);
	snapshot.archiveExport = false;
	expect((await readBridgeState()).archiveExport).toBe(false);
	expect(bridgeState().archiveExport).toBe(false);
});
test("archive export capability rejects malformed host values", async () => {
	Object.assign(snapshot, { archiveExport: "true" });
	await expect(connectBridge()).rejects.toThrow("invalid-reply");
});

test("archive input capability preserves explicit true/false and rejects malformed metadata", async () => {
	expect((await connectBridge()).archiveInput).toBeUndefined();
	snapshot.archiveInput = true;
	expect((await readBridgeState()).archiveInput).toBe(true);
	expect(bridgeState().archiveInput).toBe(true);
	snapshot.archiveInput = false;
	expect((await readBridgeState()).archiveInput).toBe(false);
	Object.assign(snapshot, { archiveInput: "true" });
	await expect(readBridgeState()).rejects.toThrow("invalid-reply");
});
