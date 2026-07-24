// Raw-body seam for the three public provider listeners (Telegram, Discord,
// Slack).
//
// Discord and Slack sign the exact octets they sent. Elysia parses JSON bodies
// by default, and once it has, the underlying Request body is spent -- calling
// request.arrayBuffer() in the handler throws "Body already used". A route that
// re-serializes the parsed object to verify is checking bytes the provider
// never signed: it passes against our own serializer and rejects every real
// callback (key order, insignificant whitespace and \uXXXX escaping all differ).
//
// So the route MUST be registered with RAW_BODY_ROUTE_CONFIG, which disables
// framework parsing; this module then reads the body once, verifies over those
// bytes, and only afterwards parses.
//
// Elysia decides whether to parse by two independent signals: it static-
// analyses the handler for a `body` reference, AND it parses whenever the route
// carries a `body` schema. Either one on its own spends the body. `parse:"none"`
// is what keeps the raw octets readable in both cases -- so a listener route may
// reference `body` or attach a `body` schema ONLY because this config is present.
// Forgetting it does not necessarily throw: under Bun the spent body reads back
// as zero bytes, so the route would answer a uniform rejection to every real
// callback rather than failing loudly.
//
// Unlike the neighbouring ack route there is no REJECT_FLOOR_MS timing pad here.
// The ack route's branches are all reachable by an unauthenticated prober, so
// their timings are an oracle. Here every branch past the signature check is
// gated on a valid signature: an attacker who cannot sign only ever sees the
// verification rejection, and the one remaining timing-distinguishable branch
// (parse failure) is unreachable without the provider's secret.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";
import type { Network } from "../client-ip.ts";
import {
	rateLimitKey,
	resolveClientIP,
	trustedProxyCIDRsFromEnv,
} from "../client-ip.ts";
import {
	ACK_RATE_CAPACITY,
	ACK_RATE_REFILL_PER_SEC,
	takeRateToken,
} from "./capability.ts";

type Database = NodePgDatabase<typeof tables>;

// Pass as the third argument of .post(). Without it Elysia consumes the body
// and no raw bytes are recoverable.
export const RAW_BODY_ROUTE_CONFIG = { parse: "none" } as const;

// Provider callbacks are small: a Slack interaction payload is a few KB, a
// Discord interaction less. These endpoints are unauthenticated, so an
// unbounded read is a memory DoS.
export const RAW_BODY_MAX_BYTES = 64 * 1024;

// One body for every pre-handler failure -- unverifiable, oversized, empty,
// unparseable. The status is the caller's because Discord requires 401 on a bad
// signature and the others do not.
export const RAW_REJECT_BODY = "Invalid request.";
export const RAW_REJECT_STATUS = 400;

// Slack posts interactivity as x-www-form-urlencoded with the interaction JSON
// in a `payload` field; Telegram and Discord post JSON. `json` is the decoded
// payload in both shapes so a listener never has to branch on transport.
//
// `kind` and a null `json` are attacker-influenced: no provider signs
// Content-Type, so a replay of a captured validly-signed callback picks which
// branch runs (a JSON body replayed as a form yields `{kind:"form",json:null}`).
// Nothing is bypassed, but a listener must either null-check `json` or pass
// `expectedMediaType` so the seam rejects the mismatch first. A duplicate
// `payload` field is NOT a smuggling vector: Slack signs the whole form octets,
// so an attacker cannot append one without breaking the signature.
export type SignedBody =
	| { kind: "json"; json: unknown; form: null }
	| { kind: "form"; json: unknown; form: URLSearchParams };

export type ExpectedMediaType =
	| "application/json"
	| "application/x-www-form-urlencoded";

export type RawBodyContext = {
	request: Request;
	raw: Uint8Array;
	body: SignedBody;
	clientIP: string;
};

export type RawBodyOptions = {
	// Runs over the raw bytes before anything is parsed. Must not throw; a throw
	// is treated as a failed verification.
	verify: (input: {
		raw: Uint8Array;
		request: Request;
	}) => boolean | Promise<boolean>;
	handle: (context: RawBodyContext) => Response | Promise<Response>;
	rateLimit: (key: string) => Promise<boolean>;
	// Content-Type is unsigned, so a listener that only handles one transport
	// declares it here rather than trusting whichever branch the caller picked.
	expectedMediaType?: ExpectedMediaType;
	rejectStatus?: number;
	maxBytes?: number;
	trustedProxies?: Network[];
};

// Null means "over the cap"; an empty array means an empty body. Both reject,
// but the read has to stop early rather than buffer first and measure after.
export async function readRawBody(
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		// Plain decimal digits only: Number() would also accept "0x100", "1e3"
		// and " 12 ", so the shortcut would not mean what it reads as. The
		// streaming re-check below is what actually governs either way.
		if (!/^\d+$/.test(declared)) return null;
		const length = Number(declared);
		if (!Number.isSafeInteger(length) || length > maxBytes) return null;
	}
	const stream = request.body;
	if (!stream) return new Uint8Array(0);

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			// Content-Length is attacker-controlled and a chunked body declares
			// nothing, so the cap is enforced on what actually arrives.
			if (total > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const raw = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		raw.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return raw;
}

function mediaType(request: Request): string {
	return (request.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
}

// Parsed only after verification. Null for anything malformed or for a media
// type no provider uses.
export function parseSignedBody(
	raw: Uint8Array,
	contentType: string,
): SignedBody | null {
	const text = new TextDecoder("utf-8", { fatal: true });
	let decoded: string;
	try {
		decoded = text.decode(raw);
	} catch {
		return null;
	}

	if (contentType === "application/json" || contentType.endsWith("+json")) {
		try {
			return { kind: "json", json: JSON.parse(decoded), form: null };
		} catch {
			return null;
		}
	}
	if (contentType === "application/x-www-form-urlencoded") {
		const form = new URLSearchParams(decoded);
		const payload = form.get("payload");
		if (payload === null) return { kind: "form", json: null, form };
		try {
			return { kind: "form", json: JSON.parse(payload), form };
		} catch {
			return null;
		}
	}
	return null;
}

// Closed set, not a caller string: the buckets live in the same `rate_bucket`
// table as the ack route's `ack:` keys, so an arbitrary prefix would let a
// listener flood eat the ack route's budget for the same address.
export type RawRateKeyPrefix = "telegram:" | "discord:" | "slack:";

// The DB-backed IP token bucket the ack route already uses. Same table, same
// refill semantics and the same defaults; a distinct keyPrefix per listener
// keeps the buckets apart.
export function dbRateLimit(
	database: Database,
	options: {
		keyPrefix: RawRateKeyPrefix;
		capacity?: number;
		refillPerSec?: number;
	},
): (key: string) => Promise<boolean> {
	const capacity = options.capacity ?? ACK_RATE_CAPACITY;
	const refillPerSec = options.refillPerSec ?? ACK_RATE_REFILL_PER_SEC;
	return (key) =>
		takeRateToken(
			database,
			`${options.keyPrefix}${key}`,
			capacity,
			refillPerSec,
		);
}

function matchesExpected(
	contentType: string,
	expected: ExpectedMediaType,
): boolean {
	if (contentType === expected) return true;
	return expected === "application/json" && contentType.endsWith("+json");
}

export function rawBodyHandler(options: RawBodyOptions) {
	const expected = options.expectedMediaType;
	const maxBytes = options.maxBytes ?? RAW_BODY_MAX_BYTES;
	const rejectStatus = options.rejectStatus ?? RAW_REJECT_STATUS;
	const trustedProxies =
		options.trustedProxies ??
		trustedProxyCIDRsFromEnv(process.env.DITERO_TRUSTED_PROXIES);
	const reject = () => new Response(RAW_REJECT_BODY, { status: rejectStatus });

	return async ({
		request,
		server,
	}: {
		request: Request;
		server?: {
			requestIP: (request: Request) => { address: string } | null;
		} | null;
	}): Promise<Response> => {
		const peerAddress = server?.requestIP(request)?.address ?? "127.0.0.1";
		const clientIP = rateLimitKey(
			resolveClientIP({
				peerAddress,
				forwardedFor: request.headers.get("x-forwarded-for"),
				trustedProxies,
			}),
		);
		// Ahead of the body read, so a flood cannot make us buffer for it. Kept
		// distinct from the uniform rejection: it is address-scoped and decided
		// before any request content is looked at, so it reveals nothing.
		if (!(await options.rateLimit(clientIP))) {
			return new Response("Too Many Requests", { status: 429 });
		}

		const raw = await readRawBody(request, maxBytes);
		if (raw === null || raw.byteLength === 0) return reject();

		let verified: boolean;
		try {
			verified = await options.verify({ raw, request });
		} catch {
			verified = false;
		}
		if (!verified) return reject();

		const contentType = mediaType(request);
		if (expected !== undefined && !matchesExpected(contentType, expected)) {
			return reject();
		}
		const body = parseSignedBody(raw, contentType);
		if (body === null) return reject();

		return await options.handle({ request, raw, body, clientIP });
	};
}
