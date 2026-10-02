import { describe, expect, it } from "vitest";
import {
	hasAmbientCredentials,
	isCanonicalId,
	isVerifier,
	normalizeLabel,
	parseApprove,
	parseBearer,
	parseCreate,
	parseExchange,
	readJsonObject,
	s256Challenge,
} from "./contracts.ts";

const ID = Buffer.alloc(32, 7).toString("base64url");
const VERIFIER = "a".repeat(43);

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
	return new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

describe("S256", () => {
	it("matches the RFC 7636 appendix B vector", () => {
		expect(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
	});

	it("accepts only unreserved ASCII of 43..128 characters", () => {
		expect(isVerifier("a".repeat(42))).toBe(false);
		expect(isVerifier("a".repeat(43))).toBe(true);
		expect(isVerifier("a".repeat(128))).toBe(true);
		expect(isVerifier("a".repeat(129))).toBe(false);
		expect(isVerifier(`${"a".repeat(42)}-._~`)).toBe(true);
		for (const bad of ["+", "/", "=", " ", "é", "\n"])
			expect(isVerifier(`${"a".repeat(42)}${bad}`)).toBe(false);
		expect(isVerifier(123)).toBe(false);
	});
});

describe("canonical ids", () => {
	it("accepts exactly 32 bytes in canonical unpadded base64url", () => {
		expect(isCanonicalId(ID)).toBe(true);
		expect(isCanonicalId(s256Challenge(VERIFIER))).toBe(true);
	});

	it("rejects wrong length, padding, alphabet and trailing bits", () => {
		expect(isCanonicalId(ID.slice(1))).toBe(false);
		expect(isCanonicalId(`${ID}=`)).toBe(false);
		expect(isCanonicalId(`${ID}A`)).toBe(false);
		expect(isCanonicalId(ID.replace(/.$/, "+"))).toBe(false);
		// 43 characters, but the last carries nonzero padding bits.
		expect(isCanonicalId(`${"A".repeat(42)}B`)).toBe(false);
		expect(isCanonicalId(null)).toBe(false);
	});
});

describe("labels", () => {
	it("trims and bounds to 1..100", () => {
		expect(normalizeLabel("  Pixel  ")).toBe("Pixel");
		expect(normalizeLabel("a".repeat(100))).toBe("a".repeat(100));
		expect(normalizeLabel("a".repeat(101))).toBeNull();
		expect(normalizeLabel("   ")).toBeNull();
		expect(normalizeLabel("bad\u0000label")).toBeNull();
		expect(normalizeLabel(5)).toBeNull();
	});
});

describe("strict bodies", () => {
	it("create takes only challenge and deviceLabel", () => {
		const ok = { challenge: ID, deviceLabel: " Phone " };
		expect(parseCreate(ok)).toEqual({ challenge: ID, deviceLabel: "Phone" });
		expect(parseCreate({ ...ok, callback: "https://x.test" })).toBeNull();
		expect(parseCreate({ challenge: ID })).toBeNull();
		expect(parseCreate({ ...ok, challenge: `${ID}=` })).toBeNull();
	});

	it("approve takes only grantId", () => {
		expect(parseApprove({ grantId: ID })).toEqual({ grantId: ID });
		expect(parseApprove({ grantId: ID, userId: "u" })).toBeNull();
		expect(parseApprove({ grantId: ID.slice(1) })).toBeNull();
		expect(parseApprove({})).toBeNull();
	});

	it("exchange takes only grantId and verifier", () => {
		expect(parseExchange({ grantId: ID, verifier: VERIFIER })).toEqual({
			grantId: ID,
			verifier: VERIFIER,
		});
		expect(
			parseExchange({ grantId: ID, verifier: VERIFIER, method: "plain" }),
		).toBeNull();
		expect(parseExchange({ grantId: ID, verifier: "short" })).toBeNull();
		expect(parseExchange({ grantId: ID })).toBeNull();
	});
});

describe("credential modes", () => {
	it("flags Origin, Cookie and Authorization", () => {
		expect(hasAmbientCredentials(new Headers())).toBe(false);
		for (const name of ["origin", "cookie", "authorization"])
			expect(hasAmbientCredentials(new Headers({ [name]: "x" }))).toBe(true);
	});

	it("parses a single well-formed Bearer header", () => {
		expect(
			parseBearer(new Headers({ authorization: "Bearer abc.DEF-1" })),
		).toBe("abc.DEF-1");
		expect(parseBearer(new Headers({ authorization: "Basic abc" }))).toBeNull();
		expect(
			parseBearer(new Headers({ authorization: "Bearer a b" })),
		).toBeNull();
		expect(parseBearer(new Headers())).toBeNull();
	});
});

describe("bounded JSON body", () => {
	it("reads a small object", async () => {
		const result = await readJsonObject(post('{"a":1}'));
		expect(result).toEqual({ ok: true, value: { a: 1 } });
	});

	it("cuts off a streamed body past the limit without a content-length", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"a":"'));
				controller.enqueue(new Uint8Array(4096).fill(97));
				controller.enqueue(new TextEncoder().encode('"}'));
				controller.close();
			},
		});
		const request = new Request("http://localhost/x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: stream,
			// @ts-expect-error required by the runtime for streamed bodies
			duplex: "half",
		});
		expect(await readJsonObject(request)).toEqual({ ok: false, status: 413 });
	});

	it("refuses a declared oversize length", async () => {
		const request = post("{}", { "content-length": "5000" });
		expect(await readJsonObject(request)).toEqual({ ok: false, status: 413 });
	});

	it("rejects non-objects, bad JSON and other media types", async () => {
		for (const body of ["[]", "null", "1", "{", '"s"'])
			expect(await readJsonObject(post(body))).toEqual({
				ok: false,
				status: 400,
			});
		expect(
			await readJsonObject(post("{}", { "content-type": "text/plain" })),
		).toEqual({ ok: false, status: 415 });
	});
});
