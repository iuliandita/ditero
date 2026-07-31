import { describe, expect, it } from "vitest";
import { redactChannelUrl } from "../../../domain/notification-channel.ts";
import { classifyRetry } from "../../../domain/notification-retry.ts";
import {
	OutboundPolicyError,
	type safeFetch,
} from "../../../security/safe-http.ts";
import { ACK_PATH, ACK_TOKEN_BYTES, ackToken } from "../capability.ts";
import {
	ACK_CALLBACK_PREFIX,
	ackCallbackData,
	CALLBACK_DATA_MAX_BYTES,
	telegramAdapter,
} from "./telegram.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

// Shaped like a real bot token (`<id>:<secret>`) and deliberately containing a
// colon and a dash, so a redactor that only strips query parameters leaves it
// intact and the leak assertions below can actually fail.
const BOT_TOKEN = "8123456789:AAH-secret_do_not_leak-xyz";

const config = { botToken: BOT_TOKEN, chatId: "-1001234567890" };

const ACK_TOKEN = "s6Ag1FaJ0k_lZ-3Qb2Xr4tYu6iOp8AsDfGhJkLzXcVb";

const payload: ChannelPayload = {
	title: "Walk the dog",
	body: "Due 2026-08-01T09:00:00.000Z",
	urgent: false,
	ackUrl: `https://app.example.test${ACK_PATH}/${ACK_TOKEN}`,
	locale: "en" as const,
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

function sentBody(call: Call): Record<string, unknown> {
	return JSON.parse(String(call.options?.body ?? "{}"));
}

function botOk(result: unknown = { message_id: 1 }): Response {
	return Response.json({ ok: true, result }, { status: 200 });
}

describe("telegramAdapter", () => {
	it("posts sendMessage to the bot endpoint with the chat id", async () => {
		const { calls, fetchImpl } = recorder(() => botOk());
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
		);
		expect(calls[0].options?.method).toBe("POST");
		const body = sentBody(calls[0]);
		expect(body.chat_id).toBe(config.chatId);
		expect(body.text).toContain("Walk the dog");
		// A parse_mode would make an unbalanced `*` in a task title a permanent 400.
		expect(body).not.toHaveProperty("parse_mode");
		// The Bot API's only urgency knob is disable_notification, i.e. mapping
		// "not urgent" onto silence. Deliberately unset, pinned so a later task
		// cannot wire payload.urgent to it and mute every ordinary reminder.
		expect(body).not.toHaveProperty("disable_notification");
	});

	it("sends no urgency knob for an urgent reminder either", async () => {
		const { calls, fetchImpl } = recorder(() => botOk());
		const result = await telegramAdapter.send(
			config,
			{ ...payload, urgent: true },
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);
		expect(sentBody(calls[0])).not.toHaveProperty("disable_notification");
	});

	// The wire format is a contract with the inbound listener (Task 5), so the
	// expectation is the literal `c:` and NOT the exported constant -- building
	// it from ACK_CALLBACK_PREFIX would make any change to the prefix pass.
	it("carries the ack capability in an inline-keyboard callback_data", async () => {
		expect(ACK_CALLBACK_PREFIX).toBe("c:");
		const { calls, fetchImpl } = recorder(() => botOk());
		await telegramAdapter.send(config, payload, context(fetchImpl));
		expect(sentBody(calls[0]).reply_markup).toEqual({
			inline_keyboard: [[{ text: "Done", callback_data: `c:${ACK_TOKEN}` }]],
		});
	});

	// The size the real capability path mints, measured in BYTES against the
	// provider's hard limit: raising ACK_TOKEN_BYTES fails HERE rather than as a
	// 400 the user sees as a missing button. The cap BRANCH is covered by the
	// ackCallbackData tests below; this one pins the budget it is spent against.
	it("mints an ack token that fits the callback_data budget", async () => {
		expect(CALLBACK_DATA_MAX_BYTES).toBe(64);
		const { calls, fetchImpl } = recorder(() => botOk());
		const token = ackToken();
		expect(token).toHaveLength(43);
		expect(Math.ceil((ACK_TOKEN_BYTES * 4) / 3)).toBe(43);

		await telegramAdapter.send(
			config,
			{ ...payload, ackUrl: `https://app.example.test${ACK_PATH}/${token}` },
			context(fetchImpl),
		);
		const markup = sentBody(calls[0]).reply_markup as {
			inline_keyboard: { callback_data: string }[][];
		};
		const data = markup.inline_keyboard[0][0].callback_data;
		// Positive first: an adapter that dropped the keyboard would otherwise
		// satisfy every length bound vacuously.
		expect(data).toBe(`c:${token}`);
		expect(Buffer.byteLength(data, "utf8")).toBe(45);
		expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(
			CALLBACK_DATA_MAX_BYTES,
		);
	});

	it("sends without a keyboard when there is no ack capability", async () => {
		const { calls, fetchImpl } = recorder(() => botOk());
		const result = await telegramAdapter.send(
			config,
			{ ...payload, ackUrl: null },
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);
		expect(sentBody(calls[0])).not.toHaveProperty("reply_markup");
	});

	// The trap this whole adapter exists to avoid: the Bot API answers HTTP 200
	// with {"ok": false} for most application errors, so a `response.ok` check
	// records a delivery for a notification nobody received.
	it("treats ok:false inside a 200 as a failure, not a delivery", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json(
				{
					ok: false,
					error_code: 403,
					description: "Forbidden: bot was blocked by the user",
				},
				{ status: 200 },
			),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ status: 403 });
		// A blocked bot never unblocks itself on a retry.
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "permanent",
			retryClass: "client",
		});
	});

	it("maps a 200 body with no envelope to a retryable failure", async () => {
		const { fetchImpl } = recorder(
			() => new Response("<html>proxy</html>", { status: 200 }),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(false);
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "transport",
		});
	});

	it("honours parameters.retry_after on a 429", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json(
				{
					ok: false,
					error_code: 429,
					description: "Too Many Requests: retry after 12",
					parameters: { retry_after: 12 },
				},
				{ status: 429 },
			),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 12 });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "retry",
			delayMs: 12_000,
			retryClass: "throttled",
		});
	});

	it("falls back to the Retry-After header when the envelope has no parameters", async () => {
		const { fetchImpl } = recorder(
			() =>
				new Response(JSON.stringify({ ok: false, error_code: 429 }), {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 7 });
	});

	// Legacy FLOOD_WAIT. classifyRetry reads 420 as a plain 4xx, so without the
	// normalisation channelErrorCode marks a throttled channel permanently broken
	// and the user's notifications stop for good.
	it.each([
		["a legacy 420 flood wait", 420],
		["a 409 conflict", 409],
	])("treats %s carrying retry_after as a throttle", async (_case, code) => {
		const { fetchImpl } = recorder(() =>
			Response.json(
				{
					ok: false,
					error_code: code,
					description: "Flood control exceeded",
					parameters: { retry_after: 9 },
				},
				{ status: 200 },
			),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 9 });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "retry",
			delayMs: 9_000,
			retryClass: "throttled",
		});
		// The operator-facing string keeps the code actually received.
		expect(result.ok === false ? result.error : "").toContain(
			`telegram ${code} `,
		);
	});

	// A 4xx with no wait attached stays permanent: normalising every 4xx to 429
	// would burn the full ~33-minute ladder on a bot the user blocked.
	it("leaves a 4xx without retry_after permanent", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json({ ok: false, error_code: 420 }, { status: 200 }),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 420 });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "permanent",
			retryClass: "client",
		});
	});

	// The persisted error is the single line an operator triages from, so it must
	// not read as a success when the envelope names no code.
	it("never reports a failure with a success-looking status", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json({ ok: false }, { status: 200 }),
		);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(false);
		const error = result.ok === false ? result.error : "";
		expect(error).not.toMatch(/telegram 2\d\d\b/);
		expect(error).toContain("no envelope code");
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "transport",
		});
	});

	it("maps a transport throw to a retryable result and never throws", async () => {
		const { fetchImpl } = recorder(() => {
			throw new Error("ECONNRESET");
		});
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(false);
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "transport",
		});
	});

	it("maps a policy rejection to a permanent result", async () => {
		const { fetchImpl } = recorder(() => {
			throw new OutboundPolicyError(
				"Outbound target must resolve to a public address",
			);
		});
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "permanent",
			retryClass: "policy",
		});
	});

	it("rejects an unusable channel config permanently", async () => {
		const { calls, fetchImpl } = recorder(() => botOk());
		const result = await telegramAdapter.send(
			{ botToken: BOT_TOKEN, chatId: "not a chat" },
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(calls).toHaveLength(0);
	});

	// The bot token rides in the URL PATH, which is the Telegram-specific half of
	// the hazard the ntfy adapter documents for Authorization headers: any error
	// string that quotes the URL quotes the credential.
	it.each([
		[
			"an HTTP error envelope",
			() =>
				Response.json(
					{
						ok: false,
						error_code: 401,
						description: `Unauthorized: token ${BOT_TOKEN} is invalid`,
					},
					{ status: 401 },
				),
		],
		[
			"a transport error quoting the URL",
			() => {
				throw new Error(
					`connect ETIMEDOUT https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
				);
			},
		],
		[
			"a policy rejection quoting the URL",
			() => {
				throw new OutboundPolicyError(
					`Outbound target must resolve to a public address: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
				);
			},
		],
	])("never leaks the bot token via %s", async (_case, respond) => {
		const { fetchImpl } = recorder(respond as (call: Call) => Response);
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(BOT_TOKEN);
		// Also the secret half alone: a redactor that only trimmed the numeric bot
		// id would pass the assertion above.
		expect(serialized).not.toContain("AAH-secret_do_not_leak-xyz");
		expect(serialized).toContain("bot[REDACTED]");
	});

	// The rule this adapter relies on lives in the domain redactor, so it is
	// asserted against exactly the URL this adapter emits rather than assumed.
	it("emits a URL that redactChannelUrl fully covers", () => {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
		expect(redactChannelUrl(url)).toBe(
			"https://api.telegram.org/bot[REDACTED]/sendMessage",
		);
	});

	// A token with a path separator would otherwise retarget the request to a
	// different Bot API method, and the redactor's `/bot[^/]+` rule would stop
	// short of the rest of the credential.
	it("percent-encodes a bot token carrying path syntax", async () => {
		const hostile = "123:AA/../deleteWebhook?x=#frag";
		const { calls, fetchImpl } = recorder(() => botOk());
		const result = await telegramAdapter.send(
			{ ...config, botToken: hostile },
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);
		const url = new URL(calls[0].url);
		expect(url.pathname).toBe(
			"/bot123:AA%2F..%2FdeleteWebhook%3Fx%3D%23frag/sendMessage",
		);
		expect(url.search).toBe("");
		expect(url.hash).toBe("");
		expect(redactChannelUrl(calls[0].url)).toBe(
			"https://api.telegram.org/bot[REDACTED]/sendMessage",
		);
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
		const result = await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl, { deadlineMs: 50 }),
		);
		const elapsed = Date.now() - started;
		expect(result.ok).toBe(false);
		// Lower bound too: without it an instant failure for an unrelated reason
		// passes this test.
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(2_000);
		// A deadline abort classified permanent is a silent delivery loss.
		expect(classifyRetry(result, 1, 0)).toMatchObject({ kind: "retry" });
	});

	it("propagates the caller's abort signal into fetch", async () => {
		const controller = new AbortController();
		const { calls, fetchImpl } = recorder(
			({ options }) =>
				new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason ?? new Error("aborted")),
					);
				}),
		);
		const pending = telegramAdapter.send(
			config,
			payload,
			context(fetchImpl, { deadlineMs: 60_000, signal: controller.signal }),
		);
		controller.abort();
		const result = await pending;
		expect(calls[0].options?.signal?.aborted).toBe(true);
		expect(result.ok).toBe(false);
		expect(classifyRetry(result, 1, 0)).toMatchObject({ kind: "retry" });
	});

	it("passes the egress policy through to safeFetch", async () => {
		const { calls, fetchImpl } = recorder(() => botOk());
		const allowedPrivateCIDRs = [] as const;
		await telegramAdapter.send(
			config,
			payload,
			context(fetchImpl, { allowedPrivateCIDRs }),
		);
		expect(calls[0].options?.allowedPrivateCIDRs).toBe(allowedPrivateCIDRs);
		expect(calls[0].options?.maxResponseBytes).toBe(64 * 1_024);
	});
});

// Both rejection branches decide whether a malformed ack URL yields NO button
// (the notification still arrives, ackable in-app) or a BROKEN one (a 400 from
// the provider, so the whole notification is lost). Tested directly: through
// send() a dropped guard shows up only as an absent reply_markup.
describe("ackCallbackData", () => {
	it("emits the prefixed token for a well-formed ack URL", () => {
		expect(ackCallbackData(payload.ackUrl)).toBe(`c:${ACK_TOKEN}`);
	});

	it.each([
		["no ack capability", null],
		["a trailing slash", `https://app.example.test${ACK_PATH}/`],
		[
			"a non-token last segment",
			`https://app.example.test${ACK_PATH}/not.a.token-at-all`,
		],
		[
			"a segment below the token length",
			`https://app.example.test${ACK_PATH}/short`,
		],
		["an unparseable URL", "not a url"],
	])("yields no button for %s", (_case, ackUrl) => {
		expect(ackCallbackData(ackUrl)).toBeNull();
	});

	// Token-shaped but too long: passes TOKEN_SEGMENT and is rejected only by the
	// byte cap. 63 + `c:` is 65, one over the provider's limit.
	it("yields no button for a token-shaped segment that busts the byte cap", () => {
		const segment = "a".repeat(63);
		expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(Buffer.byteLength(`${ACK_CALLBACK_PREFIX}${segment}`, "utf8")).toBe(
			CALLBACK_DATA_MAX_BYTES + 1,
		);
		expect(
			ackCallbackData(`https://app.example.test${ACK_PATH}/${segment}`),
		).toBeNull();
		// One byte shorter still passes, so the boundary is pinned, not just "long
		// segments are rejected".
		expect(
			ackCallbackData(
				`https://app.example.test${ACK_PATH}/${segment.slice(1)}`,
			),
		).toBe(`${ACK_CALLBACK_PREFIX}${segment.slice(1)}`);
	});
});
