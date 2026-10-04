import { getLocale } from "../../../src/paraglide/runtime.js";
import {
	NATIVE_PUSH_STATES,
	type NativeNotificationNavigation,
	type NativeNotificationTarget,
	type NativePush,
	type NativePushState,
	type NativeTaskLinkNavigation,
} from "../../../src/web/lib/native-account.tsx";

// Page side of the NativeDitero message-listener bridge (NativeZeroTransport.java) and an
// EventTarget-compatible WebSocket adapter for Zero. The page only ever holds an opaque
// auth handle: the session token, the JWT and the PKCE verifier stay in Java.
//
// Every request is one named operation from a closed union; nothing here forwards a
// caller-chosen URL, method or header. Every reply is validated field by field.

type Reply = Record<string, unknown> & { ok: boolean };

export type ServerMeta = {
	origin: string;
	queryUrl: string;
	mutateUrl: string;
};

export type SessionMeta = {
	scope: string;
	userId: string;
	deviceId: string;
	authHandle: string;
	expiresAt: string;
	tokenReady: boolean;
	jwtExp: number;
};

export type Hello = {
	taskLinks?: boolean;
	linkRefused?: boolean;
	pushProvider?: NativePushState["provider"];
	gen: number;
	server: ServerMeta | null;
	session: SessionMeta | null;
};

export type NativeProfile = { id: string; name: string; email: string };
export type NativeConfig = ServerMeta & { zeroURL: string };

const SIMPLE_OPS = [
	"state.read",
	"config.read",
	"session.read",
	"profile.read",
	"bootstrap.ensure",
	"grant",
	"browser",
	"complete",
	"refresh",
	"session.revoke",
	"forget",
] as const;
type SimpleOp = (typeof SIMPLE_OPS)[number];

export type E2eOp =
	| "e2e.memberKeys"
	| "e2e.workspaceRotate"
	| "e2e.identity"
	| "e2e.enroll"
	| "e2e.recovery"
	| "e2e.rewrap"
	| "e2e.identityRotate"
	| "e2e.provisionPending"
	| "e2e.provision"
	| "e2e.keysMine"
	| "e2e.grantsPending"
	| "e2e.grantRequest"
	| "e2e.grantsMine"
	| "e2e.grantSubmit"
	| "e2e.grantFail";

export type AttachmentOp =
	| "attachment.config"
	| "attachment.reserve"
	| "attachment.finalize"
	| "attachment.abort"
	| "attachment.delete"
	| "attachment.cancel"
	| "upload.begin"
	| "upload.write"
	| "upload.finish"
	| "download.begin"
	| "download.read"
	| "save.pick"
	| "save.write"
	| "save.finish"
	| "save.cancel"
	| "save.cancelPending"
	| "stage.begin"
	| "stage.write"
	| "stage.rewind"
	| "stage.read"
	| "stage.cancel";

type PushOp = "push.state" | "push.enable" | "push.disable" | "push.permission";

type Command =
	| { op: "server.select"; origin: string }
	| { op: SimpleOp }
	| { op: PushOp; id: string; locale?: "en" | "de" | "es" | "fr" | "ro" | "ar" }
	| { op: "push.open" | "link.read" | "link.retire"; id: string }
	| {
			op: "push.dismissOpen" | "link.dismiss";
			id: string;
			body: { token: string };
	  }
	| { op: E2eOp; id?: string; body?: Record<string, unknown> }
	| { op: AttachmentOp; body: Record<string, unknown> };

type NativeObject = {
	postMessage(message: string): void;
	onmessage: ((event: MessageEvent) => void) | null;
};

export class NativeError extends Error {
	readonly code: string;
	readonly remoteRevoked: boolean | undefined;
	readonly alreadyUnusable: boolean | undefined;

	constructor(
		code: string,
		remoteRevoked?: boolean,
		alreadyUnusable?: boolean,
	) {
		super(`native: ${code}`);
		this.name = "NativeError";
		this.code = code;
		this.remoteRevoked = remoteRevoked;
		this.alreadyUnusable = alreadyUnusable;
	}
}

// Java's own HTTP budget is 10s connect + 15s read per request, and some operations make two.
const CALL_TIMEOUT_MS = 30_000;
const MAX_RID = 0x7fffffff;
const MAX_SEND_BYTES = 1024 * 1024;

type Waiter = {
	timer: ReturnType<typeof setTimeout>;
	settle(reply: Reply): void;
	reject(error: Error): void;
};

type State = Hello & {
	// Where the selected instance's Zero cache lives; known after config.read, per generation.
	zeroUrl: URL | undefined;
};

let state: State | undefined;
let refusalHandler:
	| { gen: number; authHandle: string; run: () => void }
	| undefined;

/** Only the active Zero owner receives a confirmed native socket-session refusal. */
export function setNativeSessionRefusalHandler(
	gen: number,
	authHandle: string,
	run: () => void,
): void {
	refusalHandler = { gen, authHandle, run };
}
let rid = 0;
let nextCid = 0;
const pending = new Map<number, Waiter>();
const sockets = new Map<number, NativeWebSocket>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeObject(): NativeObject {
	const n = (globalThis as { NativeDitero?: NativeObject }).NativeDitero;
	if (!n || typeof n.postMessage !== "function")
		throw new Error("NativeDitero is not injected");
	return n;
}

function field(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	if (typeof value !== "string" || !value)
		throw new NativeError("invalid-reply");
	return value;
}

function count(source: Record<string, unknown>, key: string): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new NativeError("invalid-reply");
	return value;
}

function parseServer(value: unknown): ServerMeta | null {
	if (value === null) return null;
	if (!isRecord(value)) throw new NativeError("invalid-reply");
	const server = {
		origin: field(value, "origin"),
		queryUrl: field(value, "queryUrl"),
		mutateUrl: field(value, "mutateUrl"),
	};
	if (
		!server.origin.startsWith("https://") ||
		server.queryUrl !== `${server.origin}/api/zero/query` ||
		server.mutateUrl !== `${server.origin}/api/zero/mutate`
	)
		throw new NativeError("invalid-reply");
	return server;
}

/** The scope is Java's canonical native:[origin,userId] tuple; anything else is refused. */
function parseSession(
	value: unknown,
	server: ServerMeta | null,
): SessionMeta | null {
	if (value === null) return null;
	if (!isRecord(value) || !server) throw new NativeError("invalid-reply");
	const session = {
		scope: field(value, "scope"),
		userId: field(value, "userId"),
		deviceId: field(value, "deviceId"),
		authHandle: field(value, "authHandle"),
		expiresAt: field(value, "expiresAt"),
		tokenReady: value.tokenReady,
		jwtExp: value.jwtExp,
	};
	if (
		typeof session.tokenReady !== "boolean" ||
		typeof session.jwtExp !== "number" ||
		!Number.isFinite(session.jwtExp) ||
		session.scope !==
			`native:${JSON.stringify([server.origin, session.userId])}`
	)
		throw new NativeError("invalid-reply");
	return { ...session, tokenReady: session.tokenReady, jwtExp: session.jwtExp };
}

function parseHello(reply: Reply): Hello {
	const server = parseServer(reply.server);
	const provider = reply.pushProvider;
	if (
		provider !== undefined &&
		provider !== "unifiedpush" &&
		provider !== "google" &&
		provider !== "desktop"
	)
		throw new NativeError("invalid-reply");
	if (
		(reply.taskLinks !== undefined && typeof reply.taskLinks !== "boolean") ||
		(reply.linkRefused !== undefined && typeof reply.linkRefused !== "boolean")
	)
		throw new NativeError("invalid-reply");
	return {
		...(reply.taskLinks === undefined ? {} : { taskLinks: reply.taskLinks }),
		...(reply.linkRefused === undefined
			? {}
			: { linkRefused: reply.linkRefused }),
		...(provider === undefined ? {} : { pushProvider: provider }),
		gen: count(reply, "gen"),
		server,
		session: parseSession(reply.session, server),
	};
}

/**
 * Adopts a new snapshot. A generation change retires everything bound to the old one, in a
 * fixed order: waiting callers are rejected first, then sockets end like a failed connect.
 */
function adopt(next: Hello): void {
	const generationChanged = !state || state.gen !== next.gen;
	const changed =
		generationChanged ||
		state?.session?.scope !== next.session?.scope ||
		state?.session?.authHandle !== next.session?.authHandle;
	state = { ...next, zeroUrl: generationChanged ? undefined : state?.zeroUrl };
	if (changed) {
		rejectPending(new NativeError("stale-generation"));
		abortSockets();
	}
}

function rejectPending(error: Error): void {
	for (const [id, waiter] of [...pending]) {
		pending.delete(id);
		clearTimeout(waiter.timer);
		waiter.reject(error);
	}
}

function abortSockets(): void {
	for (const socket of [...sockets.values()]) socket.nativeAbort();
	sockets.clear();
}

function dropSessionState(): void {
	if (state) state = { ...state, session: null };
}

function sessionRefused(gen: unknown, authHandle: unknown): void {
	if (
		!state ||
		state.gen !== gen ||
		!state.session ||
		state.session.authHandle !== authHandle
	)
		return;
	const observer = refusalHandler;
	refusalHandler = undefined;
	dropSessionState();
	abortSockets();
	if (observer && observer.gen === gen && observer.authHandle === authHandle)
		observer.run();
}

const notificationListeners = new Set<() => void>();
const taskLinkListeners = new Set<() => void>();

function onNative(event: MessageEvent): void {
	let message: unknown;
	try {
		message = JSON.parse(String(event.data));
	} catch {
		return;
	}
	if (!isRecord(message)) return;
	if (message.t === "push.open" && state && message.gen === state.gen) {
		for (const listener of notificationListeners) listener();
		return;
	}
	if (
		message.t === "link.open" &&
		state?.taskLinks &&
		message.gen === state.gen
	) {
		for (const listener of taskLinkListeners) listener();
		return;
	}
	if (message.t === "session-refused") {
		sessionRefused(message.gen, message.authHandle);
		return;
	}
	if (message.t === "reply") {
		const id = message.rid;
		const waiter = typeof id === "number" ? pending.get(id) : undefined;
		if (waiter && typeof id === "number") {
			pending.delete(id);
			clearTimeout(waiter.timer);
			waiter.settle({ ...message, ok: message.ok === true });
		} else if (typeof message.cid === "number") {
			sockets
				.get(message.cid)
				?.nativeReply(message.ok === true, message.rid, message.code);
		}
		return;
	}
	if (
		message.t === "ws" &&
		state &&
		message.gen === state.gen &&
		typeof message.cid === "number"
	)
		sockets.get(message.cid)?.nativeEvent(message);
}

function nextRid(): number {
	if (rid >= MAX_RID) throw new Error("native request ids exhausted");
	return ++rid;
}

/** The waiter is installed before the post, so no reply can outrun it. */
function request<T>(
	command: Command | { op: "hello" },
	handle: (reply: Reply) => T,
	timeout = CALL_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = nextRid();
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new NativeError("timeout"));
		}, timeout);
		pending.set(id, {
			timer,
			reject,
			settle(reply) {
				// Java dropped a token the instance refused; the page must not keep claiming it.
				if (
					!reply.ok &&
					(reply.code === "unauthorized" || reply.code === "no-session")
				)
					dropSessionState();
				try {
					resolve(handle(reply));
				} catch (error) {
					reject(error);
				}
			},
		});
		try {
			const fields =
				command.op === "hello"
					? command
					: { ...command, gen: requireState().gen };
			nativeObject().postMessage(JSON.stringify({ ...fields, rid: id }));
		} catch (error) {
			pending.delete(id);
			clearTimeout(timer);
			reject(error);
		}
	});
}

function requireState(): State {
	if (!state) throw new Error("bridge not ready");
	return state;
}

function ok(reply: Reply): Reply {
	if (!reply.ok)
		throw new NativeError(
			typeof reply.code === "string" ? reply.code : "refused",
		);
	return reply;
}

/** Main-frame handshake. Must complete before any other operation or socket. */
export async function connectBridge(): Promise<Hello> {
	const native = nativeObject();
	native.onmessage = onNative;
	rejectPending(new NativeError("stale-generation"));
	abortSockets();
	state = undefined;
	const hello = await request({ op: "hello" }, (reply) =>
		parseHello(ok(reply)),
	);
	adopt(hello);
	return hello;
}

/** Credential-free metadata snapshot of the current generation. */
export function bridgeState(): Hello {
	const { gen, server, session, pushProvider, taskLinks, linkRefused } =
		requireState();
	return {
		...(pushProvider === undefined ? {} : { pushProvider }),
		...(taskLinks === undefined ? {} : { taskLinks }),
		...(linkRefused === undefined ? {} : { linkRefused }),
		gen,
		server: server && { ...server },
		session: session && { ...session },
	};
}

export type BridgeSnapshot = Hello & {
	exchanging: boolean;
	revoking: boolean;
	grantPending: boolean;
	changed: boolean;
};

/** Current-page snapshot; Java checks page ownership without requiring a matching generation. */
export async function readBridgeState(): Promise<BridgeSnapshot> {
	requireState();
	return request({ op: "state.read" }, (reply) => {
		const next = parseHello(ok(reply));
		if (
			typeof reply.exchanging !== "boolean" ||
			typeof reply.revoking !== "boolean" ||
			typeof reply.grantPending !== "boolean"
		)
			throw new NativeError("invalid-reply");
		const before = requireState();
		const changed =
			before.gen !== next.gen ||
			before.server?.origin !== next.server?.origin ||
			before.session?.scope !== next.session?.scope ||
			before.session?.authHandle !== next.session?.authHandle;
		adopt(next);
		return {
			...next,
			exchanging: reply.exchanging,
			revoking: reply.revoking,
			grantPending: reply.grantPending,
			changed,
		};
	});
}

/**
 * Changes the selected instance. Callers must have retired every Zero instance first: this
 * refuses while a socket is live, and a changed generation retires everything else.
 */
export async function selectServer(origin: string): Promise<Hello> {
	if (sockets.size > 0) throw new NativeError("busy");
	const hello = await request({ op: "server.select", origin }, (reply) =>
		parseHello(ok(reply)),
	);
	adopt(hello);
	return hello;
}

export async function readConfig(): Promise<NativeConfig> {
	const generation = requireState().gen;
	return request({ op: "config.read" }, (reply) => {
		ok(reply);
		const server = parseServer({
			origin: reply.origin,
			queryUrl: reply.queryUrl,
			mutateUrl: reply.mutateUrl,
		});
		if (!server) throw new NativeError("invalid-reply");
		const config: NativeConfig = {
			...server,
			zeroURL: field(reply, "zeroURL"),
		};
		const zeroUrl = new URL(config.zeroURL);
		const current = requireState();
		if (
			current.gen !== generation ||
			config.origin !== current.server?.origin ||
			zeroUrl.protocol !== "https:"
		)
			throw new NativeError("invalid-reply");
		state = { ...current, zeroUrl };
		return config;
	});
}

export async function readSession(): Promise<
	Pick<SessionMeta, "scope" | "userId" | "deviceId" | "expiresAt">
> {
	return request({ op: "session.read" }, (reply) => {
		ok(reply);
		return {
			scope: field(reply, "scope"),
			userId: field(reply, "userId"),
			deviceId: field(reply, "deviceId"),
			expiresAt: field(reply, "expiresAt"),
		};
	});
}

export async function readProfile(): Promise<NativeProfile> {
	return request({ op: "profile.read" }, (reply) => {
		ok(reply);
		const profile = {
			id: field(reply, "id"),
			name: reply.name,
			email: reply.email,
		};
		if (typeof profile.name !== "string" || typeof profile.email !== "string")
			throw new NativeError("invalid-reply");
		if (profile.id !== state?.session?.userId)
			throw new NativeError("invalid-reply");
		return { id: profile.id, name: profile.name, email: profile.email };
	});
}

export async function ensureBootstrap(): Promise<{ workspaceId: string }> {
	return request({ op: "bootstrap.ensure" }, (reply) => ({
		workspaceId: field(ok(reply), "workspaceId"),
	}));
}

export type GrantInfo = { authorizeUrl: string; expiresAt: string };

export async function requestGrant(): Promise<GrantInfo> {
	return request({ op: "grant" }, (reply) => ({
		authorizeUrl: field(ok(reply), "authorizeUrl"),
		expiresAt: field(reply, "expiresAt"),
	}));
}

export async function openBrowser(): Promise<void> {
	return request({ op: "browser" }, (reply) => void ok(reply));
}

/** Reconcile before retrying: a timed-out exchange may have completed in Java. */
export async function completeOnce(): Promise<
	"pending" | "finishing" | SessionMeta
> {
	const before = bridgeState();
	const classify = (
		snapshot: BridgeSnapshot,
	): "finishing" | SessionMeta | undefined => {
		if (snapshot.server?.origin !== before.server?.origin)
			throw new NativeError("stale-generation");
		if (
			snapshot.session &&
			(snapshot.session.authHandle !== before.session?.authHandle ||
				!snapshot.grantPending)
		)
			return { ...snapshot.session };
		if (snapshot.exchanging) return "finishing";
		if (!snapshot.grantPending) throw new NativeError("no-pending-grant");
		return undefined;
	};
	const restored = classify(await readBridgeState());
	if (restored) return restored;
	try {
		return await request({ op: "complete" }, (reply) => {
			ok(reply);
			if (reply.state === "pending") return "pending";
			if (reply.state !== "signed-in") throw new NativeError("invalid-reply");
			const current = requireState();
			const session = parseSession(reply.session, current.server);
			if (!session) throw new NativeError("invalid-reply");
			adopt({ ...current, session });
			return { ...session };
		});
	} catch (error) {
		if (
			!(error instanceof NativeError) ||
			!["timeout", "busy", "no-pending-grant"].includes(error.code)
		)
			throw error;
		return classify(await readBridgeState()) ?? "pending";
	}
}

export async function refreshToken(): Promise<{
	refreshedAt: number;
	jwtExp: number;
}> {
	return request({ op: "refresh" }, (reply) => {
		ok(reply);
		const refreshedAt = count(reply, "refreshedAt");
		const jwtExp = count(reply, "jwtExp");
		const current = requireState();
		if (!current.session) throw new NativeError("no-session");
		state = {
			...current,
			session: { ...current.session, tokenReady: true, jwtExp },
		};
		return { refreshedAt, jwtExp };
	});
}

export type RevokeResult = {
	authorityAbsent: true;
	localCleared: boolean;
	remote: "revoked" | "already-unusable" | "unknown";
};

/** An unknown remote result is never reported as confirmed revocation. */
export async function revokeSession(): Promise<RevokeResult> {
	const before = bridgeState();
	const reconcile = (snapshot: BridgeSnapshot): RevokeResult | undefined => {
		if (
			snapshot.server?.origin !== before.server?.origin ||
			(snapshot.session &&
				snapshot.session.authHandle !== before.session?.authHandle)
		)
			throw new NativeError("stale-generation");
		if (!snapshot.session)
			return { authorityAbsent: true, localCleared: false, remote: "unknown" };
		if (snapshot.revoking) throw new NativeError("revoking");
		return undefined;
	};
	const restored = reconcile(await readBridgeState());
	if (restored) return restored;
	try {
		return await request({ op: "session.revoke" }, (reply) => {
			if (!reply.ok) {
				const code = typeof reply.code === "string" ? reply.code : "refused";
				if (reply.remoteRevoked === true || reply.alreadyUnusable === true) {
					dropSessionState();
					throw new NativeError(
						code,
						reply.remoteRevoked === true,
						reply.alreadyUnusable === true,
					);
				}
				throw new NativeError(code);
			}
			if (reply.remoteRevoked !== true && reply.alreadyUnusable !== true)
				throw new NativeError("invalid-reply");
			dropSessionState();
			return {
				authorityAbsent: true,
				localCleared: true,
				remote: reply.remoteRevoked === true ? "revoked" : "already-unusable",
			};
		});
	} catch (error) {
		if (
			!(error instanceof NativeError) ||
			!["timeout", "busy", "no-session"].includes(error.code)
		)
			throw error;
		const restored = reconcile(await readBridgeState());
		if (restored) return restored;
		throw error;
	}
}

/** Local sign-out only: no server revocation. */
export async function forgetSession(): Promise<void> {
	return request({ op: "forget" }, (reply) => {
		ok(reply);
		dropSessionState();
	});
}

export type E2eResult = { status: number; body: string | null };

/**
 * One fixed encryption operation. The native status is authoritative: an error status the
 * instance returned comes back as a result, while transport and policy refusals reject.
 */
export async function callE2e(
	op: E2eOp,
	args: { id?: string; body?: Record<string, unknown> } = {},
): Promise<E2eResult> {
	return request({ op, ...args }, (reply) => {
		const status = reply.status;
		const body = typeof reply.body === "string" ? reply.body : null;
		const usable =
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 200 &&
			status <= 599;
		if (!usable || (reply.ok === false && status < 300))
			throw new NativeError(
				typeof reply.code === "string" ? reply.code : "invalid-reply",
			);
		return { status, body };
	});
}

/** Closed file operations; callers still validate each operation's fields. */
export function callAttachment(
	op: AttachmentOp,
	body: Record<string, unknown> = {},
): Promise<Reply> {
	return request(
		{ op, body },
		(reply) => {
			// HTTP refusals remain responses. Only native policy/transport failures throw.
			if (
				!reply.ok &&
				!(
					typeof reply.status === "number" &&
					Number.isInteger(reply.status) &&
					reply.status >= 300 &&
					reply.status <= 599
				)
			)
				ok(reply);
			return reply;
		},
		op === "save.pick" ? 300_000 : CALL_TIMEOUT_MS,
	);
}

// ---- WebSocket adapter ------------------------------------------------------------

const OPENISH = ["open", "message", "close", "error"] as const;

export class NativeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;

	binaryType: BinaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	#url: string;
	#cid: number;
	#gen: number;
	#authHandle: string | undefined;
	#state = 0;
	#openRid = 0;
	#finished = false;
	#started = false;
	#queue: Array<() => void> = [];

	constructor(url: string | URL, protocols?: string | string[]) {
		super();
		const current = requireState();
		const parsed = new URL(String(url));
		const zero = current.zeroUrl;
		// The target must be the selected instance's Zero cache, learned from config.read.
		if (
			!zero ||
			parsed.protocol !== "wss:" ||
			parsed.host !== zero.host ||
			!parsed.pathname.startsWith(`${zero.pathname.replace(/\/+$/, "")}/`) ||
			typeof protocols !== "string"
		)
			throw new DOMException("target refused", "SecurityError");
		this.#url = parsed.toString();
		this.#cid = ++nextCid;
		this.#gen = current.gen;
		this.#authHandle = current.session?.authHandle;
		for (const name of OPENISH) {
			this.addEventListener(name, (event) => {
				const handler = this[`on${name}` as "onopen"] as
					| ((e: Event) => void)
					| null;
				if (typeof handler === "function") handler.call(this, event);
			});
		}
		sockets.set(this.#cid, this);
		// Events arrive on later tasks; this keeps even a synchronous first event
		// behind listeners attached right after construction.
		setTimeout(() => {
			this.#started = true;
			const queued = this.#queue;
			this.#queue = [];
			for (const run of queued) run();
		}, 0);
		try {
			this.#openRid = this.#post({
				op: "ws.open",
				cid: this.#cid,
				url: this.#url,
				protocol: protocols,
			});
		} catch (error) {
			sockets.delete(this.#cid);
			throw error;
		}
	}

	get readyState(): number {
		return this.#state;
	}
	get url(): string {
		return this.#url;
	}
	// The negotiated subprotocol carries the auth handle in Zero's scheme; never reflect it.
	get protocol(): string {
		return "";
	}
	get extensions(): string {
		return "";
	}
	get bufferedAmount(): number {
		return 0;
	}

	send(data: unknown): void {
		if (this.#state === 0)
			throw new DOMException("still connecting", "InvalidStateError");
		if (typeof data !== "string")
			throw new TypeError("native transport carries text frames only");
		if (this.#state !== 1) return;
		if (
			new TextEncoder().encode(data).length > MAX_SEND_BYTES ||
			JSON.stringify(data).length > MAX_SEND_BYTES
		) {
			this.close();
			this.#fail(1006);
			throw new TypeError("native frame too large");
		}
		this.#post({ op: "ws.send", cid: this.#cid, data });
	}

	close(code?: number, reason?: string): void {
		if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999))
			throw new DOMException("invalid close code", "InvalidAccessError");
		if (reason !== undefined && new TextEncoder().encode(reason).length > 123)
			throw new DOMException("reason too long", "SyntaxError");
		if (this.#state >= 2) return;
		this.#state = 2;
		this.#post({
			op: "ws.close",
			cid: this.#cid,
			code: code ?? 1000,
			reason: reason ?? "",
		});
	}

	/** Refused sends must end the socket so Zero cannot silently lose a frame. */
	nativeReply(accepted: boolean, replyRid: unknown, code?: unknown): void {
		if (accepted) return;
		if (
			replyRid === this.#openRid &&
			(code === "unauthorized" || code === "no-session") &&
			state?.gen === this.#gen &&
			state.session?.authHandle === this.#authHandle
		) {
			sessionRefused(this.#gen, this.#authHandle);
			return;
		}
		// A refused open never reaches the network: end like a failed connect, from
		// CONNECTING or from CLOSING (close() raced the refusal). #finish is once-only.
		if (
			(replyRid === this.#openRid &&
				(this.#state === 0 || this.#state === 2)) ||
			(typeof replyRid === "number" && this.#state === 1)
		)
			this.#fail(1006);
	}

	nativeEvent(event: Record<string, unknown>): void {
		this.#deliver(() => {
			if (this.#finished) return;
			switch (event.e) {
				case "open":
					if (this.#state === 0) {
						this.#state = 1;
						this.dispatchEvent(new Event("open"));
					}
					break;
				case "message":
					if (
						typeof event.data === "string" &&
						(this.#state === 1 || this.#state === 2)
					)
						this.dispatchEvent(
							new MessageEvent("message", { data: event.data }),
						);
					break;
				case "error":
					this.dispatchEvent(new Event("error"));
					break;
				case "close":
					this.#finish(
						typeof event.code === "number" ? event.code : 1006,
						typeof event.reason === "string" ? event.reason : "",
						event.clean === true,
					);
					break;
			}
		});
	}

	/** The generation this socket belonged to ended: fail it like a dropped connection. */
	nativeAbort(): void {
		this.#fail(1006);
	}

	// A socket from an older generation can no longer reach native; nothing is posted for it.
	#post(fields: Record<string, unknown>): number {
		const current = requireState();
		if (current.gen !== this.#gen)
			throw new DOMException("stale generation", "InvalidStateError");
		const id = nextRid();
		nativeObject().postMessage(
			JSON.stringify({ ...fields, rid: id, gen: current.gen }),
		);
		return id;
	}

	#deliver(run: () => void): void {
		if (this.#started) run();
		else this.#queue.push(run);
	}

	#fail(code: number): void {
		this.#deliver(() => {
			if (this.#finished) return;
			this.dispatchEvent(new Event("error"));
			this.#finish(code, "", false);
		});
	}

	#finish(code: number, reason: string, wasClean: boolean): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#state = 3;
		sockets.delete(this.#cid);
		this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
	}
}

let restoreHook: (() => void) | undefined;

/**
 * Replaces globalThis.WebSocket with the native adapter and returns the matching restore
 * function. Zero 1.9 resolves globalThis.WebSocket at connect time and exposes no constructor
 * injection, so this hook is the only way to route its socket through native. Call it once
 * from the bundled Android entry, after connectBridge(), and nowhere else; it is idempotent.
 * No fetch, cookie or header patching exists or is permitted.
 */
export function installNativeWebSocket(): () => void {
	requireState();
	if (restoreHook) return restoreHook;
	const original = globalThis.WebSocket;
	(globalThis as { WebSocket: unknown }).WebSocket = NativeWebSocket;
	restoreHook = () => {
		(globalThis as { WebSocket: unknown }).WebSocket = original;
		restoreHook = undefined;
	};
	return restoreHook;
}

/** Fixed native operations, bound to the verified account that owns this UI. */
export function createNativePush(
	gen: number,
	authHandle: string,
	provider: NativePushState["provider"] = "unifiedpush",
): NativePush {
	const assertCurrent = () => {
		const current = requireState();
		if (current.gen !== gen || current.session?.authHandle !== authHandle)
			throw new NativeError("stale-generation");
	};
	const call = async (op: PushOp): Promise<NativePushState> => {
		assertCurrent();
		const command: Command = { op, id: authHandle };
		if (provider === "desktop" && op !== "push.disable") {
			const locale = getLocale();
			if (!["en", "de", "es", "fr", "ro", "ar"].includes(locale))
				throw new NativeError("invalid-locale");
			command.locale = locale;
		}
		return request(command, (reply) => {
			assertCurrent();
			ok(reply);
			if (
				!NATIVE_PUSH_STATES.some((value) => value === reply.state) ||
				(reply.permission !== "granted" && reply.permission !== "denied") ||
				reply.provider !== provider ||
				(reply.state === "active" && reply.permission !== "granted")
			)
				throw new NativeError("invalid-reply");
			return {
				state: reply.state as NativePushState["state"],
				permission: reply.permission,
				provider,
			};
		});
	};
	return {
		identity: JSON.stringify([gen, authHandle, provider]),
		provider,
		read: () => call("push.state"),
		enable: () => call("push.enable"),
		disable: () => call("push.disable"),
		permission: () => call("push.permission"),
	};
}

export function createNativeNotificationNavigation(
	gen: number,
	authHandle: string,
): NativeNotificationNavigation {
	const assertCurrent = () => {
		const current = requireState();
		if (current.gen !== gen || current.session?.authHandle !== authHandle)
			throw new NativeError("stale-generation");
	};
	return {
		identity: JSON.stringify([gen, authHandle]),
		async read() {
			assertCurrent();
			return request({ op: "push.open", id: authHandle }, (reply) => {
				assertCurrent();
				ok(reply);
				if (reply.open === null) return null;
				if (!isRecord(reply.open) || Object.keys(reply.open).length !== 2)
					throw new NativeError("invalid-reply");
				const { token, target } = reply.open;
				const validId = (value: unknown): value is string =>
					typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
				if (
					!validId(token) ||
					!isRecord(target) ||
					!validId(target.workspaceId)
				)
					throw new NativeError("invalid-reply");
				let parsed: NativeNotificationTarget;
				if (
					target.kind === "task" &&
					Object.keys(target).length === 4 &&
					validId(target.listId) &&
					validId(target.taskId)
				) {
					parsed = {
						kind: "task",
						workspaceId: target.workspaceId,
						listId: target.listId,
						taskId: target.taskId,
					};
				} else if (
					target.kind === "workspace" &&
					Object.keys(target).length === 2
				) {
					parsed = { kind: "workspace", workspaceId: target.workspaceId };
				} else throw new NativeError("invalid-reply");
				return { token, target: parsed };
			});
		},
		async dismiss(token) {
			assertCurrent();
			await request(
				{ op: "push.dismissOpen", id: authHandle, body: { token } },
				(reply) => {
					assertCurrent();
					ok(reply);
				},
			);
		},
		subscribe(listener) {
			const guarded = () => {
				try {
					assertCurrent();
				} catch {
					return;
				}
				listener();
			};
			notificationListeners.add(guarded);
			return () => {
				notificationListeners.delete(guarded);
			};
		},
	};
}

/** Linux link identities never authorize a server switch or a task mutation. */
export function createNativeTaskLinkNavigation(
	gen: number,
	authHandle: string,
): NativeTaskLinkNavigation {
	const assertCurrent = () => {
		const current = requireState();
		if (
			!current.taskLinks ||
			current.gen !== gen ||
			current.session?.authHandle !== authHandle
		)
			throw new NativeError("stale-generation");
	};
	const validId = (value: unknown): value is string =>
		typeof value === "string" &&
		/^[A-Za-z0-9_.:-]{1,128}$/.test(value) &&
		value !== "." &&
		value !== "..";
	return {
		identity: JSON.stringify([gen, authHandle]),
		async retire() {
			assertCurrent();
			await request({ op: "link.retire", id: authHandle }, (reply) => {
				assertCurrent();
				ok(reply);
			});
		},
		async read() {
			assertCurrent();
			return request({ op: "link.read", id: authHandle }, (reply) => {
				assertCurrent();
				ok(reply);
				if (reply.open === null) return null;
				if (
					!isRecord(reply.open) ||
					Object.keys(reply.open).length !== 2 ||
					!validId(reply.open.token) ||
					(reply.open.taskId !== null && !validId(reply.open.taskId))
				)
					throw new NativeError("invalid-reply");
				return { token: reply.open.token, taskId: reply.open.taskId };
			});
		},
		async dismiss(token) {
			assertCurrent();
			if (!validId(token)) throw new NativeError("invalid-message");
			await request(
				{ op: "link.dismiss", id: authHandle, body: { token } },
				(reply) => {
					assertCurrent();
					ok(reply);
				},
			);
		},
		subscribe(listener) {
			const guarded = () => {
				try {
					assertCurrent();
				} catch {
					return;
				}
				listener();
			};
			taskLinkListeners.add(guarded);
			return () => {
				taskLinkListeners.delete(guarded);
			};
		},
	};
}
