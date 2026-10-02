// Native ZeroRuntime and E2eRuntime for the Android shell. Both are bound to one verified
// native context (instance, account, generation, session handle) captured up front: after a
// server or account change they refuse instead of retargeting.

import type { PublicConfig } from "../../../src/server/public-config.ts";
import type { E2eRuntime } from "../../../src/web/lib/e2e/runtime.ts";
import type { E2eFetcher } from "../../../src/web/lib/e2e/workspace-keys.ts";
import { SessionExpiredError } from "../../../src/web/lib/zero-auth.ts";
import type { NativeZeroRuntime } from "../../../src/web/lib/zero-runtime.ts";
import {
	bridgeState,
	callE2e,
	type E2eOp,
	ensureBootstrap,
	NativeError,
	readBridgeState,
	readConfig,
	readSession,
	refreshToken,
	revokeSession,
} from "./bridge.ts";

export class StaleNativeContextError extends Error {
	constructor() {
		super("native context changed");
		this.name = "StaleNativeContextError";
	}
}

/** Public identity of one native instance/account/generation; never carries a credential. */
export type NativeContext = {
	readonly gen: number;
	readonly origin: string;
	readonly scope: string;
	readonly userId: string;
	readonly deviceId: string;
	readonly authHandle: string;
};

// Only contexts produced by captureVerifiedContext are accepted by createNativeRuntime.
const verified = new WeakSet<object>();

/**
 * Captures the current context after native confirmed the session with the instance
 * (session.read). Rejects if the generation or account moved while that was in flight.
 */
export async function captureVerifiedContext(): Promise<NativeContext> {
	const before = bridgeState();
	if (!before.server || !before.session) throw new NativeError("no-session");
	const { server, session } = before;
	const confirmed = await readSession();
	const after = bridgeState();
	if (
		after.gen !== before.gen ||
		after.session?.authHandle !== session.authHandle ||
		confirmed.scope !== session.scope ||
		confirmed.userId !== session.userId ||
		confirmed.deviceId !== session.deviceId
	)
		throw new StaleNativeContextError();
	const context: NativeContext = Object.freeze({
		gen: before.gen,
		origin: server.origin,
		scope: session.scope,
		userId: session.userId,
		deviceId: session.deviceId,
		authHandle: session.authHandle,
	});
	verified.add(context);
	return context;
}

function assertCurrent(context: NativeContext): void {
	const { gen, server, session } = bridgeState();
	if (
		gen !== context.gen ||
		server?.origin !== context.origin ||
		session?.scope !== context.scope ||
		session.userId !== context.userId ||
		session.deviceId !== context.deviceId ||
		session.authHandle !== context.authHandle
	)
		throw new StaleNativeContextError();
}

// The only encryption routes the app uses. Each maps one browser method and path to one fixed
// native operation; Java owns the real path, method and body schema.
type Route = { method: "GET" | "POST"; op: E2eOp };

const STATIC_ROUTES = new Map<string, Route>();
for (const [path, method, op] of [
	["/api/e2e/identity", "GET", "e2e.identity"],
	["/api/e2e/enroll", "POST", "e2e.enroll"],
	["/api/e2e/identity/recovery", "GET", "e2e.recovery"],
	["/api/e2e/rewrap", "POST", "e2e.rewrap"],
	["/api/e2e/identity/rotate", "POST", "e2e.identityRotate"],
	["/api/e2e/provision/pending", "GET", "e2e.provisionPending"],
	["/api/e2e/provision", "POST", "e2e.provision"],
	["/api/e2e/keys/mine", "GET", "e2e.keysMine"],
	["/api/e2e/grants/pending", "GET", "e2e.grantsPending"],
	["/api/e2e/grants/request", "POST", "e2e.grantRequest"],
	["/api/e2e/grants/mine", "GET", "e2e.grantsMine"],
	["/api/e2e/grants", "POST", "e2e.grantSubmit"],
	["/api/e2e/grants/fail", "POST", "e2e.grantFail"],
] as const)
	STATIC_ROUTES.set(path, { method, op });

const ID_ROUTES: ReadonlyArray<{ pattern: RegExp; route: Route }> = [
	{
		pattern: /^\/api\/e2e\/members\/([^/]+)\/keys$/,
		route: { method: "GET", op: "e2e.memberKeys" },
	},
	{
		pattern: /^\/api\/e2e\/workspaces\/([^/]+)\/rotate$/,
		route: { method: "POST", op: "e2e.workspaceRotate" },
	},
];

// Mirrors Java's id check; Java stays authoritative.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_BODY_BYTES = 64 * 1024;
// A caller may describe its content, never authenticate: anything else is refused.
const ALLOWED_HEADERS = new Set(["content-type", "accept"]);

function resolveRoute(input: unknown): { route: Route; id?: string } {
	if (typeof input !== "string")
		throw new TypeError("e2e: target must be a path string");
	// Relative app paths only: no scheme, authority, query, fragment or backslash.
	if (
		!input.startsWith("/api/e2e/") ||
		/[?#\\]/.test(input) ||
		input.startsWith("//")
	)
		throw new TypeError("e2e: target refused");
	const fixed = STATIC_ROUTES.get(input);
	if (fixed) return { route: fixed };
	for (const { pattern, route } of ID_ROUTES) {
		const match = pattern.exec(input);
		if (!match) continue;
		let id: string;
		try {
			id = decodeURIComponent(match[1] ?? "");
		} catch {
			throw new TypeError("e2e: target refused");
		}
		if (!ID.test(id) || id === "." || id === "..")
			throw new TypeError("e2e: target refused");
		return { route, id };
	}
	throw new TypeError("e2e: target refused");
}

function checkHeaders(headers: HeadersInit | undefined): void {
	if (headers === undefined) return;
	for (const [name] of new Headers(headers))
		if (!ALLOWED_HEADERS.has(name))
			throw new TypeError(`e2e: header ${name} refused`);
}

function parseBody(
	route: Route,
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	if (route.method === "GET") {
		if (body !== undefined && body !== null)
			throw new TypeError("e2e: GET carries no body");
		return undefined;
	}
	if (
		typeof body !== "string" ||
		new TextEncoder().encode(body).length > MAX_BODY_BYTES
	)
		throw new TypeError("e2e: body refused");
	const parsed: unknown = JSON.parse(body);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new TypeError("e2e: body refused");
	return Object.fromEntries(Object.entries(parsed));
}

// A caller's abort rejects that caller only. Native cannot cancel an in-flight request, so
// its reply is dropped; it is keyed by request id and can never reach another caller.
function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal | null | undefined,
): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function createFetcher(context: NativeContext): E2eFetcher {
	// init.credentials ("include" in the browser call sites) is ignored on purpose: the named
	// native transport authenticates itself, and nothing credential-like is synthesized here.
	return async (input, init) => {
		assertCurrent(context);
		const { route, id } = resolveRoute(input);
		const method = (init?.method ?? "GET").toUpperCase();
		if (method !== route.method) throw new TypeError("e2e: method refused");
		checkHeaders(init?.headers);
		const body = parseBody(route, init?.body);
		const signal = init?.signal;
		signal?.throwIfAborted();
		const result = await untilAborted(
			callE2e(route.op, {
				...(id === undefined ? {} : { id }),
				...(body ? { body } : {}),
			}),
			signal,
		);
		signal?.throwIfAborted();
		assertCurrent(context);
		const empty =
			result.body === null ||
			result.status === 204 ||
			result.status === 205 ||
			result.status === 304;
		return new Response(empty ? null : result.body, {
			status: result.status,
			headers: empty ? undefined : { "content-type": "application/json" },
		});
	};
}

export type NativeRuntimeHooks = {
	/** Tears down the Zero instance (and its sockets); sign-out runs only after it resolved. */
	retireZero(): Promise<void>;
	/** Called asynchronously after native session metadata changed to signed out. */
	onSessionEnded(): void;
	onSessionEndFailed?(): void;
};

export type NativeRuntimes = {
	readonly userId: string;
	readonly scope: string;
	readonly zero: NativeZeroRuntime;
	readonly e2e: E2eRuntime;
};

export function createNativeRuntime(
	context: NativeContext,
	hooks: NativeRuntimeHooks,
): NativeRuntimes {
	if (!verified.has(context))
		throw new Error("native context was not verified");
	const notifyLater = () => setTimeout(hooks.onSessionEnded, 0);

	const zero: NativeZeroRuntime = {
		kind: "native",
		storageScope: context.scope,
		async bootstrap() {
			assertCurrent(context);
			try {
				await ensureBootstrap();
			} catch (error) {
				if (
					error instanceof NativeError &&
					["unauthorized", "no-session"].includes(error.code)
				) {
					const snapshot = await readBridgeState();
					if (!snapshot.session) {
						await hooks.retireZero();
						notifyLater();
					} else if (snapshot.changed) {
						hooks.onSessionEndFailed?.();
					}
				}
				throw error;
			}
			assertCurrent(context);
		},
		async fetchConfig(): Promise<PublicConfig> {
			assertCurrent(context);
			const config = await readConfig();
			assertCurrent(context);
			return { zeroURL: config.zeroURL };
		},
		// Refreshes the Java-held JWT, then hands Zero the opaque handle, never the token.
		async getAuth() {
			assertCurrent(context);
			try {
				await refreshToken();
			} catch (error) {
				if (
					error instanceof NativeError &&
					["unauthorized", "no-session"].includes(error.code)
				) {
					const snapshot = await readBridgeState();
					if (!snapshot.session) {
						await hooks.retireZero();
						notifyLater();
					} else if (snapshot.changed) {
						hooks.onSessionEndFailed?.();
					}
					throw new SessionExpiredError(
						"native session refused the token refresh",
					);
				}
				throw error;
			}
			assertCurrent(context);
			return context.authHandle;
		},
	};

	const e2e: E2eRuntime = {
		fetcher: createFetcher(context),
		// Confirmed replies prove durable cleanup. A snapshot can only prove absent
		// authority; that outcome leaves the account UI with an explicit failure notice.
		async signOut() {
			try {
				assertCurrent(context);
				await hooks.retireZero();
				assertCurrent(context);
				const result = await revokeSession();
				if (result.remote === "unknown") hooks.onSessionEndFailed?.();
				notifyLater();
			} catch (error) {
				if (
					error instanceof NativeError &&
					(error.remoteRevoked || error.alreadyUnusable)
				)
					notifyLater();
				hooks.onSessionEndFailed?.();
				throw error;
			}
		},
	};

	return { userId: context.userId, scope: context.scope, zero, e2e };
}
