// The seam's whole reason to exist is byte fidelity, so the tests are written
// against bytes: a body whose re-serialization differs from what was sent
// (key order, whitespace, \uXXXX escaping), signed over the original octets.
// A canonical JSON fixture would re-serialize to itself and prove nothing.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { Elysia, t } from "elysia";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../../domain/channel-signature.ts";
import { UNKNOWN_CLIENT_IP } from "../client-ip.ts";
import {
	parseSignedBody,
	RAW_BODY_MAX_BYTES,
	RAW_BODY_ROUTE_CONFIG,
	RAW_REJECT_BODY,
	rawBodyHandler,
	readRawBody,
} from "./raw-body.ts";

const SECRET = "signing-secret";
const NOW = 1_700_000_000_000;
const TS = String(Math.floor(NOW / 1000));

// Insignificant whitespace, non-lexicographic key order and an escaped
// non-ASCII code point beside a literal one: JSON.stringify(JSON.parse(x))
// cannot reproduce any of it.
const NON_CANONICAL = '{"z":1,  "a":"caf\\u00e9 é✓",\n"n":[1,2]}';
const RAW = new TextEncoder().encode(NON_CANONICAL);

function slackSignature(body: Uint8Array, timestamp = TS): string {
	const base = Buffer.concat([
		Buffer.from(`v0:${timestamp}:`, "utf8"),
		Buffer.from(body),
	]);
	return `v0=${createHmac("sha256", SECRET).update(base).digest("hex")}`;
}

function signedHeaders(
	body: Uint8Array,
	contentType = "application/json",
): Record<string, string> {
	return {
		"content-type": contentType,
		"x-slack-request-timestamp": TS,
		"x-slack-signature": slackSignature(body),
	};
}

type Call = { raw: Uint8Array; ok: boolean };

const calls: Call[] = [];
const handled: unknown[] = [];
let rateTokens = Number.POSITIVE_INFINITY;
let rateKeys: string[] = [];

const seam = rawBodyHandler({
	rejectStatus: 401,
	rateLimit: async (key) => {
		rateKeys.push(key);
		if (rateTokens <= 0) return false;
		rateTokens -= 1;
		return true;
	},
	verify: ({ raw, request }) => {
		const ok = verifySlackSignature(
			SECRET,
			request.headers.get("x-slack-signature") ?? "",
			request.headers.get("x-slack-request-timestamp") ?? "",
			raw,
			NOW,
		);
		calls.push({ raw, ok });
		return ok;
	},
	handle: ({ body, raw }) => {
		handled.push(body.json);
		return Response.json({ bytes: Buffer.from(raw).toString("hex") });
	},
});

// The trap this seam exists to close: a route that lets Elysia parse and then
// verifies over a re-serialized body. Mounted alongside so the same signed
// request can be replayed against both.
const naive = async ({
	request,
	body,
}: {
	request: Request;
	body: unknown;
}) => {
	const reserialized = new TextEncoder().encode(JSON.stringify(body));
	const ok = verifySlackSignature(
		SECRET,
		request.headers.get("x-slack-signature") ?? "",
		request.headers.get("x-slack-request-timestamp") ?? "",
		reserialized,
		NOW,
	);
	return Response.json({
		ok,
		bytes: Buffer.from(reserialized).toString("hex"),
		// Proves the original bytes are gone by the time the handler runs.
		rawError: await request
			.arrayBuffer()
			.then(() => null)
			.catch((error: Error) => error.message),
	});
};

// Same seam, but declaring what transport it accepts. Content-Type is unsigned,
// so a replayed callback would otherwise choose the parse branch.
const jsonOnly = rawBodyHandler({
	rejectStatus: 401,
	expectedMediaType: "application/json",
	rateLimit: async () => true,
	verify: ({ raw }) => {
		calls.push({ raw, ok: true });
		return true;
	},
	handle: ({ body }) => {
		handled.push(body.json);
		return new Response("ok");
	},
});

const app = new Elysia()
	.post("/seam", seam, RAW_BODY_ROUTE_CONFIG)
	// A body schema makes Elysia parse on its own, independently of whether the
	// handler mentions `body`. Registering one here is what makes
	// RAW_BODY_ROUTE_CONFIG observable: the seam's own handler never references
	// `body`, so without a second parse trigger the config kills nothing.
	.post("/seam-schema", seam, {
		...RAW_BODY_ROUTE_CONFIG,
		body: t.Object({ z: t.Number(), a: t.String(), n: t.Array(t.Number()) }),
	})
	.post("/seam-json-only", jsonOnly, RAW_BODY_ROUTE_CONFIG)
	.post("/naive", naive);

function reset() {
	calls.length = 0;
	handled.length = 0;
	rateTokens = Number.POSITIVE_INFINITY;
	rateKeys = [];
}

// app.handle rather than app.listen: vitest runs this suite under Node, where
// Elysia's web-standard adapter has no listen. The real-Bun server path is
// covered by the spawned-runtime test at the bottom.
const post = (path: string, init: RequestInit) =>
	app.handle(
		new Request(`http://localhost${path}`, { method: "POST", ...init }),
	);

describe("raw-body seam", () => {
	it("hands the verifier the original octets, not a re-serialization", async () => {
		reset();
		// Guard on the fixture itself: if this ever became canonical JSON the
		// test below would pass for the wrong reason.
		expect(JSON.stringify(JSON.parse(NON_CANONICAL))).not.toBe(NON_CANONICAL);

		const response = await post("/seam", {
			headers: signedHeaders(RAW),
			body: RAW,
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].ok).toBe(true);
		expect(Buffer.from(calls[0].raw)).toEqual(Buffer.from(RAW));
		expect(await response.json()).toEqual({
			bytes: Buffer.from(RAW).toString("hex"),
		});
		expect(handled).toEqual([JSON.parse(NON_CANONICAL)]);
	});

	// RAW_BODY_ROUTE_CONFIG's only observable effect. On a route that also
	// carries a body schema, dropping `parse:"none"` makes Elysia consume the
	// body before the handler runs: the seam then sees a spent stream, which
	// throws on Node's adapter and reads back as zero bytes under Bun. Either
	// way this route stops answering 200 with the octets.
	it("keeps the raw bytes readable on a route that also declares a body schema", async () => {
		reset();
		const response = await post("/seam-schema", {
			headers: signedHeaders(RAW),
			body: RAW,
		});

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(Buffer.from(calls[0].raw)).toEqual(Buffer.from(RAW));
		expect(await response.json()).toEqual({
			bytes: Buffer.from(RAW).toString("hex"),
		});
	});

	// The negative half: the same signed bytes fail a framework-parsed route,
	// and the original body is unrecoverable there.
	it("is not achievable on a framework-parsed route", async () => {
		const response = await post("/naive", {
			headers: signedHeaders(RAW),
			body: RAW,
		});
		const result = (await response.json()) as {
			ok: boolean;
			bytes: string;
			rawError: string | null;
		};
		expect(result.ok).toBe(false);
		expect(result.bytes).not.toBe(Buffer.from(RAW).toString("hex"));
		// Wording differs between Bun and Node; the fact does not.
		expect(result.rawError).toMatch(/already (been )?(read|used)/i);
	});

	it("decodes Slack's form-encoded payload after verifying the form octets", async () => {
		reset();
		const payload = JSON.stringify({ type: "block_actions", z: 1 });
		const form = `payload=${encodeURIComponent(payload)}&team_id=T1`;
		const bytes = new TextEncoder().encode(form);

		const response = await post("/seam", {
			headers: signedHeaders(bytes, "application/x-www-form-urlencoded"),
			body: form,
		});

		expect(response.status).toBe(200);
		expect(Buffer.from(calls[0].raw)).toEqual(Buffer.from(bytes));
		expect(handled).toEqual([JSON.parse(payload)]);
	});

	it("rejects with the caller's status and a uniform body when verification fails", async () => {
		reset();
		const tampered = new TextEncoder().encode(NON_CANONICAL.replace("1", "2"));
		const response = await post("/seam", {
			headers: signedHeaders(RAW),
			body: tampered,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
		expect(calls[0].ok).toBe(false);
		expect(handled).toHaveLength(0);
	});

	it("rejects an oversized body before verifying it", async () => {
		reset();
		const big = new Uint8Array(RAW_BODY_MAX_BYTES + 1).fill(0x61);
		const response = await post("/seam", {
			headers: signedHeaders(big),
			body: big,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
		expect(calls).toHaveLength(0);
	});

	it("rejects an empty body before verifying it", async () => {
		reset();
		const response = await post("/seam", {
			headers: signedHeaders(new Uint8Array(0)),
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
		expect(calls).toHaveLength(0);
	});

	it("rejects a body the signature covers but nothing can parse", async () => {
		reset();
		const bytes = new TextEncoder().encode("not json");
		const response = await post("/seam", {
			headers: signedHeaders(bytes),
			body: bytes,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
		expect(calls[0].ok).toBe(true);
		expect(handled).toHaveLength(0);
	});

	// The media type is not covered by any provider signature, so a captured
	// valid callback can be replayed under a different one. A listener that
	// declares its transport must not be handed the other branch.
	it("rejects a media type the listener did not declare", async () => {
		reset();
		const form = "payload=%7B%22a%22%3A1%7D";
		const bytes = new TextEncoder().encode(form);
		const response = await post("/seam-json-only", {
			headers: signedHeaders(bytes, "application/x-www-form-urlencoded"),
			body: form,
		});

		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
		expect(handled).toHaveLength(0);
	});

	it("accepts a +json suffix for a listener declaring application/json", async () => {
		reset();
		const response = await post("/seam-json-only", {
			headers: signedHeaders(RAW, "application/vnd.provider+json"),
			body: RAW,
		});

		expect(response.status).toBe(200);
		expect(handled).toEqual([JSON.parse(NON_CANONICAL)]);
	});

	// The claimed property is that a flood cannot make us buffer, so the
	// assertion is that the body was never reached -- "the verifier went
	// uncalled" and "the status is 429" both stay true with the read moved
	// first. Driven straight at the seam, and through a proxy rather than a
	// flagging ReadableStream, because the Request constructor starts draining a
	// stream body on its own the moment it is built.
	it("applies the IP rate limit ahead of the body read", async () => {
		reset();
		rateTokens = 0;
		let touchedBody = false;
		const request = new Request("http://localhost/seam", {
			method: "POST",
			headers: signedHeaders(RAW),
			body: RAW,
		});
		const watched = new Proxy(request, {
			get(target, property) {
				if (property === "body") touchedBody = true;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const response = await seam({ request: watched });

		expect(response.status).toBe(429);
		expect(touchedBody).toBe(false);
		expect(calls).toHaveLength(0);
		// No server here, so requestIP is absent and the key collapses to the
		// shared unknown bucket rather than a synthesized 127.0.0.1 (issue #37).
		expect(rateKeys).toEqual([UNKNOWN_CLIENT_IP]);
	});
});

describe("parseSignedBody", () => {
	const bytes = (value: string) => new TextEncoder().encode(value);

	// The bad byte sits inside otherwise-valid JSON on purpose: garbage that
	// cannot parse either way would pass with a non-fatal decoder too, which is
	// the decoder setting this test exists to hold.
	it("rejects bytes that are not valid UTF-8", () => {
		const invalid = new Uint8Array([...bytes('{"a":"'), 0xff, ...bytes('"}')]);
		expect(parseSignedBody(invalid, "application/json")).toBeNull();
	});

	it("parses a +json media type as JSON", () => {
		expect(
			parseSignedBody(bytes('{"a":1}'), "application/vnd.provider+json"),
		).toEqual({ kind: "json", json: { a: 1 }, form: null });
	});

	// Telegram-style form posts carry no `payload`; the listener gets the fields
	// and a null `json` rather than a rejection.
	it("returns a null json for a form without a payload field", () => {
		const parsed = parseSignedBody(
			bytes("team_id=T1"),
			"application/x-www-form-urlencoded",
		);
		expect(parsed?.kind).toBe("form");
		expect(parsed?.json).toBeNull();
		expect(parsed?.form?.get("team_id")).toBe("T1");
	});

	// Not a smuggling vector -- the whole form is signed -- but the resolution
	// must be pinned: first wins, and the listener can still see both.
	it("takes the first of duplicate payload fields", () => {
		const parsed = parseSignedBody(
			bytes("payload=%7B%22a%22%3A1%7D&payload=%7B%22a%22%3A2%7D"),
			"application/x-www-form-urlencoded",
		);
		expect(parsed?.json).toEqual({ a: 1 });
		expect(parsed?.form?.getAll("payload")).toHaveLength(2);
	});

	it("rejects an unknown media type", () => {
		expect(parseSignedBody(bytes('{"a":1}'), "text/plain")).toBeNull();
	});
});

// The suite above runs on Elysia's web-standard adapter under Node. Production
// runs a real Bun server, where the default parser consumes the body outright,
// so the claim is re-proved on that runtime rather than assumed to carry over.
describe("raw-body seam under Bun", () => {
	it("receives unmodified bytes from a real Bun server", async () => {
		const child = spawn(
			"bun",
			["run", join(import.meta.dirname, "raw-body.bun-server.ts")],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		try {
			const port = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no port")), 20_000);
				let out = "";
				// Without this a missing `bun` binary hangs out the timeout and
				// surfaces as an unhandled exception instead of a failed test.
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.stdout.on("data", (chunk: Buffer) => {
					out += chunk.toString();
					const match = out.match(/port:(\d+)/);
					if (match) {
						clearTimeout(timer);
						resolve(match[1]);
					}
				});
			});

			const response = await fetch(`http://localhost:${port}/seam`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: RAW,
			});
			expect(await response.text()).toBe(Buffer.from(RAW).toString("hex"));
		} finally {
			child.kill("SIGKILL");
		}
	}, 30_000);
});

describe("readRawBody", () => {
	it("stops at the cap when content-length lies", async () => {
		const body = new Uint8Array(64).fill(0x61);
		const request = new Request("http://localhost/x", {
			method: "POST",
			body,
			headers: { "content-length": "1" },
		});
		expect(await readRawBody(request, 16)).toBeNull();
	});

	// The declared length is refused on its own, so a request announcing
	// megabytes is rejected on the header rather than after buffering them.
	it("refuses a declared length over the cap", async () => {
		const request = new Request("http://localhost/x", {
			method: "POST",
			body: new Uint8Array(1),
			headers: { "content-length": "1048576" },
		});
		expect(await readRawBody(request, 16)).toBeNull();
	});

	// Number() would take "0x10", "1e3" and " 12 " as lengths, so the shortcut
	// would silently accept declarations it appears to reject.
	it("refuses a content-length that is not plain decimal digits", async () => {
		// No padded form here: Headers already trims, so " 12 " would arrive as
		// "12" and the case would test nothing.
		for (const declared of ["0x100", "1e3", "+12", "12.", "-1"]) {
			const request = new Request("http://localhost/x", {
				method: "POST",
				body: new Uint8Array(1),
				headers: { "content-length": declared },
			});
			expect(await readRawBody(request, 4096)).toBeNull();
		}
	});

	it("returns an empty array for a bodyless request", async () => {
		const request = new Request("http://localhost/x", { method: "POST" });
		expect(await readRawBody(request, 16)).toEqual(new Uint8Array(0));
	});
});
