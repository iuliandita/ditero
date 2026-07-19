import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRetry } from "../../../domain/notification-retry.ts";
import {
	OutboundPolicyError,
	type safeFetch,
} from "../../../security/safe-http.ts";
import { ntfyAdapter } from "./ntfy.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

const config = {
	serverUrl: "https://ntfy.example.test",
	topic: "ditero-alerts",
	token: "tk_secret",
};

const payload: ChannelPayload = {
	title: "Walk the dog",
	body: "Due 2026-08-01T09:00:00.000Z",
	urgent: false,
	ackUrl: "https://app.example.test/api/notifications/ack/abc123",
};

type Call = { url: string; options: Parameters<typeof safeFetch>[1] };

function context(
	fetchImpl: typeof safeFetch,
	overrides: Partial<AdapterContext> = {},
): AdapterContext {
	return {
		allowedPrivateCIDRs: [],
		deadlineMs: 5_000,
		signal: new AbortController().signal,
		fetch: fetchImpl,
		...overrides,
	};
}

function recorder(respond: (call: Call) => Promise<Response> | Response) {
	const calls: Call[] = [];
	const fetchImpl = (async (url, options = {}) => {
		const call = { url: String(url), options };
		calls.push(call);
		return await respond(call);
	}) as typeof safeFetch;
	return { calls, fetchImpl };
}

function headerMap(options: Parameters<typeof safeFetch>[1]): Headers {
	return new Headers(options?.headers);
}

describe("ntfyAdapter", () => {
	it("posts to <serverUrl>/<topic>", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://ntfy.example.test/ditero-alerts");
		expect(calls[0].options?.method).toBe("POST");
	});

	it("sends the ack capability as an http Actions entry", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(config, payload, context(fetchImpl));
		const actions = headerMap(calls[0].options).get("Actions");
		expect(actions).toContain("http");
		expect(actions).toContain(payload.ackUrl);
		expect(actions).toContain("method=POST");
	});

	it("omits Actions when there is no ack capability", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(
			config,
			{ ...payload, ackUrl: null },
			context(fetchImpl),
		);
		expect(headerMap(calls[0].options).get("Actions")).toBeNull();
	});

	it("maps a 2xx to ok", async () => {
		const { fetchImpl } = recorder(() => new Response("", { status: 200 }));
		const result = await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(result).toEqual({ ok: true, status: 200 });
	});

	it("maps a 429 with Retry-After to a throttled retry", async () => {
		const { fetchImpl } = recorder(
			() =>
				new Response("slow down", {
					status: 429,
					headers: { "Retry-After": "30" },
				}),
		);
		const result = await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 30 });
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "throttled",
		});
	});

	it("maps a transport throw to a retryable result and never throws", async () => {
		const { fetchImpl } = recorder(() => {
			throw new Error("ECONNRESET");
		});
		const result = await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(result.ok).toBe(false);
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "transport",
		});
	});

	// C17: without a distinguishable error type these look identical to a
	// transport blip and burn the whole retry ladder on a channel that can never
	// succeed -- and an SSRF probe gets retried rather than shut down.
	it.each([
		["blocked address", "Outbound target must resolve to a public address"],
		["bad protocol", "Outbound URL protocol must be HTTP or HTTPS"],
		["url credentials", "Outbound URL credentials are not allowed"],
		[
			"oversized response",
			"Outbound response exceeds the configured size limit",
		],
	])("maps a %s policy rejection to a permanent result", async (_case, message) => {
		const { fetchImpl } = recorder(() => {
			throw new OutboundPolicyError(message);
		});
		const result = await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "permanent",
			retryClass: "policy",
		});
	});

	it("rejects an unusable channel config permanently", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		const result = await ntfyAdapter.send(
			{ serverUrl: "ftp://nope", topic: "x" },
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(calls).toHaveLength(0);
	});

	it("raises the ntfy priority for an urgent reminder", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(
			config,
			{ ...payload, urgent: true },
			context(fetchImpl),
		);
		expect(headerMap(calls[0].options).get("Priority")).toBe("urgent");

		const { calls: plain, fetchImpl: plainFetch } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(config, payload, context(plainFetch));
		expect(headerMap(plain[0].options).get("Priority")).toBeNull();
	});

	// C20: the title is user-controlled. A newline is a header-injection attempt
	// undici rejects outright (turning a badly-named task into a permanent
	// delivery failure), and a comma breaks the Actions parse.
	it("sanitizes a hostile task title", async () => {
		const hostile =
			'Buy milk, eggs; "now"\r\nX-Injected: yes\nAuthorization: Bearer x';
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		const result = await ntfyAdapter.send(
			config,
			{ ...payload, title: hostile, body: hostile },
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);

		const headers = headerMap(calls[0].options);
		// Constructing Headers would already have thrown on a raw CR/LF; assert
		// the value itself so a future non-Headers transport is covered too.
		for (const [name, value] of headers.entries()) {
			expect(value, `${name} must be single-line`).not.toMatch(/[\r\n]/);
		}
		// The text itself survives, flattened: a title is not a place to censor
		// words, it is a place a delimiter must not survive.
		expect(headers.get("X-Title")).toContain("Buy milk, eggs");

		const actions = headers.get("Actions") ?? "";
		expect(actions).toMatch(/^http,\s*"[^"]*",\s*\S+,\s*method=POST/);
		expect(actions).toContain(payload.ackUrl);
	});

	it("caps the title length", async () => {
		const { calls, fetchImpl } = recorder(
			() => new Response("", { status: 200 }),
		);
		await ntfyAdapter.send(
			config,
			{ ...payload, title: "x".repeat(5_000) },
			context(fetchImpl),
		);
		const title = headerMap(calls[0].options).get("X-Title") ?? "";
		expect(title.length).toBeLessThanOrEqual(200);
	});

	// C18: safeFetch's bodyTimeout bounds only the gap between chunks, so a
	// server dripping one byte at a time holds a worker slot forever.
	it("aborts on its own deadline when the caller's signal never fires", async () => {
		const { fetchImpl } = recorder(
			({ options }) =>
				new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason ?? new Error("aborted")),
					);
				}),
		);
		const started = Date.now();
		const result = await ntfyAdapter.send(
			config,
			payload,
			context(fetchImpl, { deadlineMs: 50 }),
		);
		expect(result.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("propagates the caller's abort signal into fetch", async () => {
		const controller = new AbortController();
		const { fetchImpl } = recorder(
			({ options }) =>
				new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason ?? new Error("aborted")),
					);
				}),
		);
		const pending = ntfyAdapter.send(
			config,
			payload,
			context(fetchImpl, { deadlineMs: 60_000, signal: controller.signal }),
		);
		controller.abort();
		expect((await pending).ok).toBe(false);
	});

	it("never leaks the channel token into the result", async () => {
		const { fetchImpl } = recorder(() => {
			throw new Error(
				"connect failed to https://user:pw@ntfy.example.test/t?k=1",
			);
		});
		const result = await ntfyAdapter.send(config, payload, context(fetchImpl));
		expect(JSON.stringify(result)).not.toContain(config.token);
		expect(JSON.stringify(result)).not.toContain("pw@");
	});
});

const NOTIFICATION_SOURCES = "src/server/notifications";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? sourceFiles(join(dir, entry.name))
			: entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
				? [join(dir, entry.name)]
				: [],
	);
}

// The single highest-severity control in M3, so it is asserted positively: the
// negative form alone is bypassable (C19) via globalThis.fetch, undici's
// request, or an alias, and scanning only adapters/ misses dispatch.ts.
describe("notification egress policy", () => {
	it("every adapter routes outbound HTTP through safeFetch", () => {
		const files = sourceFiles(join(NOTIFICATION_SOURCES, "adapters"));
		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			expect(source, `${file} must import safeFetch`).toMatch(
				/import\s+(?:type\s+)?\{[^}]*safeFetch[^}]*\}\s+from\s+["'][^"']*security\/safe-http\.ts["']/,
			);
		}
	});

	it("nothing under notifications reaches the network directly", () => {
		for (const file of sourceFiles(NOTIFICATION_SOURCES)) {
			const source = readFileSync(file, "utf8");
			expect(source, `${file} must not call the network directly`).not.toMatch(
				/\bfetch\s*\(|\brequest\s*\(|["']undici["']|["']node:https?["']/,
			);
		}
	});
});
