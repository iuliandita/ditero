import { describe, expect, it } from "vitest";
import {
	channelErrorCode,
	classifyRetry,
} from "../../../domain/notification-retry.ts";
import {
	OutboundPolicyError,
	type safeFetch,
} from "../../../security/safe-http.ts";
import { ACK_PATH } from "../capability.ts";
import {
	ACK_ACTION_ID,
	ACK_VALUE_PREFIX,
	ACTION_ID_MAX,
	ACTION_VALUE_MAX,
	type AckButton,
	type AppBlock,
	appBlocks,
	appBody,
	type LinkButton,
	messageBlocks,
	type PostMessageBody,
	type SlackBlock,
	slackAdapter,
	type WebhookMessageBody,
	webhookBody,
} from "./slack.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

// Shaped like a real incoming webhook: the bearer credential is the LAST PATH
// SEGMENT, and the `T…/B…` ids ahead of it identify the workspace and the hook.
// A redactor that only strips `?...` leaves all three intact, so the leak
// assertions below can actually fail.
const WEBHOOK_SECRET = "aBcDeFgH1234567890secretDoNotLeak";
const WEBHOOK_TAIL = `T0A1B2C3D4/B0E5F6G7H8/${WEBHOOK_SECRET}`;
const WEBHOOK_URL = `https://hooks.slack.com/services/${WEBHOOK_TAIL}`;

const config = { mode: "webhook", webhookUrl: WEBHOOK_URL };

const ACK_TOKEN = "s6Ag1FaJ0k_lZ-3Qb2Xr4tYu6iOp8AsDfGhJkLzXcVb";
const ACK_URL = `https://app.example.test${ACK_PATH}/${ACK_TOKEN}`;

const payload: ChannelPayload = {
	title: "Walk the dog",
	body: "Due 2026-08-01T09:00:00.000Z",
	urgent: false,
	ackUrl: ACK_URL,
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

function sentBlocks(call: Call): SlackBlock[] {
	const blocks = sentBody(call).blocks;
	// Never `?? []`: an absent `blocks` must fail here rather than make every
	// assertion below hold vacuously over an empty array.
	expect(Array.isArray(blocks)).toBe(true);
	return blocks as SlackBlock[];
}

// Slack's documented success for an incoming webhook: HTTP 200, plain text.
function posted(): Response {
	return new Response("ok", {
		status: 200,
		headers: { "Content-Type": "text/plain" },
	});
}

describe("slackAdapter", () => {
	it("posts to the webhook and treats a plain-text `ok` body as delivered", async () => {
		const { calls, fetchImpl } = recorder(() => posted());
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
		// Exact: an incoming webhook answers `ok`, not JSON. A classifier built on
		// res.json() would throw on every successful send.
		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(WEBHOOK_URL);
		expect(calls[0].options?.method).toBe("POST");

		const body = sentBody(calls[0]);
		expect(body.text).toBe("Walk the dog");
		expect(sentBlocks(calls[0])[0]).toEqual({
			type: "section",
			text: {
				type: "plain_text",
				text: "Walk the dog\n\nDue 2026-08-01T09:00:00.000Z",
			},
		});
	});

	// The wire shape is a contract with Slack, so the expectation is the literal
	// JSON and not values rebuilt from the module's own constants. A LINK button
	// is the only kind an incoming webhook can carry: it is send-only, so an
	// interactive button would render a control with nothing behind it.
	it("sends the ack capability as a Block Kit link button", async () => {
		const { calls, fetchImpl } = recorder(() => posted());
		await slackAdapter.send(config, payload, context(fetchImpl));

		const blocks = sentBlocks(calls[0]);
		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toEqual({
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Done" },
					url: ACK_URL,
				},
			],
		});
		// The two fields that would make it interactive. Asserted on the
		// serialized body, since that is what Slack receives.
		const serialized = String(calls[0].options?.body);
		expect(serialized).not.toContain("action_id");
		expect(serialized).not.toContain("value");
	});

	// The guard itself, not the behaviour: these are compile-time assertions, and
	// `tsc --noEmit` fails on an UNUSED @ts-expect-error. Widening the button to
	// admit an app-chosen action_id or a value payload, or letting a select menu
	// into an actions block, therefore breaks typecheck rather than silently
	// emitting a control an incoming webhook can never dispatch.
	it("makes an interactive Block Kit element unrepresentable in webhook mode", () => {
		const link: LinkButton = {
			type: "button",
			text: { type: "plain_text", text: "Done" },
			url: ACK_URL,
		};
		// Positive first: the permitted shape must actually be constructible, or
		// every negative below holds vacuously.
		expect(link.url).toBe(ACK_URL);

		// @ts-expect-error an app-chosen action_id is the interaction dispatch key
		const withActionId: LinkButton = { ...link, action_id: "ack" };
		// @ts-expect-error `value` is the field an ack capability would ride in
		const withValue: LinkButton = { ...link, value: `c:${ACK_TOKEN}` };
		// @ts-expect-error a button with no url expects a callback, not a link
		const noUrl: LinkButton = {
			type: "button",
			text: { type: "plain_text", text: "Done" },
		};
		// The type the block builder returns, so the guard is load-bearing on the
		// value actually serialized rather than on a decorative alias.
		const emitted: readonly SlackBlock[] = [
			{
				type: "actions",
				// @ts-expect-error a static select is interactive and cannot be sent
				elements: [{ type: "static_select", action_id: "pick", options: [] }],
			},
		];
		const body: WebhookMessageBody = {
			text: "x",
			blocks: [
				{
					type: "actions",
					// @ts-expect-error an interactive button cannot reach the wire body
					elements: [{ ...link, action_id: "ack" }],
				},
			],
		};

		// Everything above is a FRESH object literal, which TypeScript rejects on
		// excess-property checking alone -- those assertions still pass with the
		// `?: never` fields deleted. The realistic path is a value assembled
		// elsewhere (a helper) and passed in, where only `?: never` rejects it.
		const widenedAction = { ...link, action_id: "ack" };
		// @ts-expect-error `action_id?: never`, not excess-property checking, rejects this
		const fromWidenedAction: LinkButton = widenedAction;
		const widenedValue = { ...link, value: `c:${ACK_TOKEN}` };
		// @ts-expect-error `value?: never`, not excess-property checking, rejects this
		const fromWidenedValue: LinkButton = widenedValue;
		// And at the two containing shapes, since bodies get built from helpers.
		const assembledRow = {
			type: "actions" as const,
			elements: [widenedAction],
		};
		// @ts-expect-error an assembled interactive button cannot reach an actions block
		const fromAssembledRow: readonly SlackBlock[] = [assembledRow];
		const assembledBody = { text: "x", blocks: [assembledRow] };
		// @ts-expect-error nor the serialized webhook body
		const fromAssembledBody: WebhookMessageBody = assembledBody;

		expect([
			withActionId,
			withValue,
			noUrl,
			emitted,
			body,
			fromWidenedAction,
			fromWidenedValue,
			fromAssembledRow,
			fromAssembledBody,
		]).toHaveLength(9);
	});

	it("sends without a button when there is no ack capability", async () => {
		const { calls, fetchImpl } = recorder(() => posted());
		const result = await slackAdapter.send(
			config,
			{ ...payload, ackUrl: null },
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);
		// Exactly the section, and nothing resembling a control: a length check
		// alone would pass against a body that lost `blocks` entirely.
		const blocks = sentBlocks(calls[0]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("section");
		expect(String(calls[0].options?.body)).not.toContain("actions");
	});

	// A shared channel is exactly where a task title becomes someone else's
	// notification storm: `<!channel>` in mrkdwn pings every member.
	it("cannot be used to broadcast a channel mention", async () => {
		const { calls, fetchImpl } = recorder(() => posted());
		await slackAdapter.send(
			config,
			{
				...payload,
				title: "<!channel> buy milk",
				body: "also <!here> and <!everyone>",
			},
			context(fetchImpl),
		);
		const serialized = String(calls[0].options?.body);
		for (const broadcast of ["<!channel>", "<!here>", "<!everyone>"]) {
			expect(serialized).not.toContain(broadcast);
		}
		// Structural half: the user text sits in a plain_text object, which does
		// not parse the syntax at all. Escaping is the second layer, and the one
		// that covers the mrkdwn-parsed top-level fallback.
		const blocks = sentBlocks(calls[0]);
		expect(blocks[0]).toEqual({
			type: "section",
			text: {
				type: "plain_text",
				text: "&lt;!channel&gt; buy milk\n\nalso &lt;!here&gt; and &lt;!everyone&gt;",
			},
		});
		expect(sentBody(calls[0]).text).toBe("&lt;!channel&gt; buy milk");
		// A bare `@channel` is not escaped at all; what makes it inert is that
		// link_names is never set, so Slack does not linkify names in the first
		// place. Setting it would re-arm the broadcast this test exists to prevent.
		expect(sentBody(calls[0])).not.toHaveProperty("link_names");
	});

	// Slack reports the wait as SECONDS in a Retry-After header on a 429;
	// incoming webhooks allow roughly one message per second per channel. Read as
	// milliseconds it becomes a 7ms retry against an endpoint that already said
	// no; there is no JSON envelope to read it from.
	it("honours Retry-After on a 429", async () => {
		const { fetchImpl } = recorder(
			() =>
				new Response("rate_limited", {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
		);
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
		expect(result).toMatchObject({ status: 429, retryAfterSec: 7 });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "retry",
			delayMs: 7_000,
			retryClass: "throttled",
		});
	});

	// A revoked or deleted webhook never fixes itself; a 5xx does. Getting this
	// backwards either burns the ~33-minute ladder on a dead channel or abandons
	// a reminder over a momentary Slack outage.
	// `errorCode` is what reaches notification_channel.lastErrorCode, so a wrong
	// permanent classification is what silently kills a channel; null is the
	// retryable case, where the channel must not be marked broken at all.
	it.each([
		[
			"a disabled hook",
			403,
			"action_prohibited",
			"permanent",
			"client",
			"auth",
		],
		["a deleted hook", 404, "no_service", "permanent", "client", "not_found"],
		[
			"a malformed body",
			400,
			"invalid_payload",
			"permanent",
			"client",
			"policy",
		],
		[
			"a gateway error",
			502,
			"<html>bad gateway</html>",
			"retry",
			"server",
			null,
		],
		["an outage", 500, "server_error", "retry", "server", null],
	])("classifies %s as %s", async (_case, status, bodyText, kind, retryClass, errorCode) => {
		const { fetchImpl } = recorder(
			() => new Response(String(bodyText), { status: Number(status) }),
		);
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
		expect(result).toMatchObject({ ok: false, status });
		const decision = classifyRetry(result, 1, 0);
		expect(decision).toMatchObject({ kind, retryClass });
		expect(channelErrorCode(decision, Number(status))).toBe(errorCode);
		// The plain-text error code is what an operator triages from.
		expect(result.ok === false ? result.error : "").toContain(
			String(bodyText).slice(0, 20),
		);
	});

	it("maps a transport throw to a retryable result and never throws", async () => {
		const { fetchImpl } = recorder(() => {
			throw new Error("ECONNRESET");
		});
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
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
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "permanent",
			retryClass: "policy",
		});
	});

	it.each([
		[
			"a non-Slack host",
			{ mode: "webhook", webhookUrl: "https://evil.test/x" },
		],
		[
			"a lookalike host",
			{ mode: "webhook", webhookUrl: "https://hooks.slack.com.evil.test/x" },
		],
		["an unknown mode", { mode: "matrix", webhookUrl: WEBHOOK_URL }],
	])("refuses to send for %s", async (_case, unusable) => {
		const { calls, fetchImpl } = recorder(() => posted());
		const result = await slackAdapter.send(
			unusable,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		// Never a silent downgrade to a buttonless send.
		expect(calls).toHaveLength(0);
	});

	// The bearer credential rides in the URL PATH, so any error string that
	// quotes the URL quotes the credential, and it survives a query-only
	// redactor. The `T…/B…` ids ahead of it go too.
	it.each([
		[
			"an HTTP error body echoing the hook",
			() =>
				new Response(`invalid_token for /services/${WEBHOOK_TAIL}`, {
					status: 403,
				}),
		],
		[
			"a transport error quoting the URL",
			() => {
				throw new Error(`connect ETIMEDOUT ${WEBHOOK_URL}`);
			},
		],
		[
			"a policy rejection quoting the URL",
			() => {
				throw new OutboundPolicyError(
					`Outbound target must resolve to a public address: ${WEBHOOK_URL}`,
				);
			},
		],
	])("never leaks the webhook credential via %s", async (_case, respond) => {
		const { fetchImpl } = recorder(respond as (call: Call) => Response);
		const result = await slackAdapter.send(config, payload, context(fetchImpl));
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(WEBHOOK_SECRET);
		// Also a prefix of it: a redactor that trimmed only the trailing
		// characters would pass the assertion above.
		expect(serialized).not.toContain("aBcDeFgH1234");
		// And the ids ahead of it, which redactChannelUrl's last-segment rule
		// leaves behind on its own.
		expect(serialized).not.toContain("T0A1B2C3D4");
		expect(serialized).not.toContain("B0E5F6G7H8");
		expect(serialized).toContain("[REDACTED]");
	});

	// The config schema constrains the webhook URL's scheme, host and length, not
	// its path charset. A stored token holding a character `new URL()`
	// percent-encodes leaves the raw and normalized forms different strings, and
	// the provider echoes back the RAW one.
	it("scrubs the stored webhook token in its un-normalized form too", async () => {
		const rawSecret = "aBcDeFgH1234567890secret WiTh SpAcE";
		const rawTail = `T0A1B2C3D4/B0E5F6G7H8/${rawSecret}`;
		const url = `https://hooks.slack.com/services/${rawTail}`;
		expect(new URL(url).pathname).not.toContain(rawSecret);
		const { fetchImpl } = recorder(() => {
			throw new Error(`connect ETIMEDOUT ${url}`);
		});
		const result = await slackAdapter.send(
			{ mode: "webhook", webhookUrl: url },
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(rawSecret);
		expect(serialized).not.toContain("aBcDeFgH1234");
		expect(serialized).not.toContain("T0A1B2C3D4");
		expect(serialized).toContain("[REDACTED]");
	});

	// The scrubber matches literal strings, so a short path segment would blank
	// ordinary words out of the one line an operator triages from.
	it("does not scrub a path segment too short to be a credential", async () => {
		const { fetchImpl } = recorder(
			() => new Response("invalid_payload", { status: 400 }),
		);
		const result = await slackAdapter.send(
			{ mode: "webhook", webhookUrl: "https://hooks.slack.com/services/pay" },
			payload,
			context(fetchImpl),
		);
		expect(result.ok === false ? result.error : "").toContain(
			"invalid_payload",
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
		const result = await slackAdapter.send(
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
		const pending = slackAdapter.send(
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
		const { calls, fetchImpl } = recorder(() => posted());
		const allowedPrivateCIDRs = [] as const;
		await slackAdapter.send(
			config,
			payload,
			context(fetchImpl, { allowedPrivateCIDRs }),
		);
		expect(calls[0].options?.allowedPrivateCIDRs).toBe(allowedPrivateCIDRs);
		expect(calls[0].options?.maxResponseBytes).toBe(64 * 1_024);
	});
});

// Tested directly: through send() a dropped button shows up only as an absent
// actions block, which is indistinguishable from the legitimate no-ack path.
describe("messageBlocks", () => {
	it.each([
		["no ack capability", null],
		["a non-HTTP scheme", `ditero://ack/${ACK_TOKEN}`],
		["an unparseable URL", "not a url"],
	])("emits no actions block for %s", (_case, ackUrl) => {
		const blocks = messageBlocks({ ...payload, ackUrl });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("section");
	});

	// Slack's `url` cap is 3000; one over is a 400 that loses the whole
	// notification, not just the button.
	it("emits no actions block past the 3000-character url cap", () => {
		const base = `https://app.example.test${ACK_PATH}/`;
		const tooLong = base + "a".repeat(3_001 - base.length);
		expect(tooLong).toHaveLength(3_001);
		expect(messageBlocks({ ...payload, ackUrl: tooLong })).toHaveLength(1);
		// One shorter still gets a button, so the boundary is pinned rather than
		// "long URLs are rejected".
		expect(
			messageBlocks({ ...payload, ackUrl: tooLong.slice(0, 3_000) }),
		).toHaveLength(2);
	});

	it("caps the section text at Slack's 3000-character limit", () => {
		const blocks = messageBlocks({ ...payload, title: "x".repeat(5_000) });
		const section = blocks[0];
		// Exact: `toBeLessThanOrEqual` also passes if the text truncates to "".
		expect(section.type === "section" ? section.text.text : "").toHaveLength(
			3_000,
		);
	});
});

describe("webhookBody", () => {
	// The `&` pass must run before `<`, or a user's literal `&lt;!channel&gt;`
	// decodes back into a live broadcast on Slack's side.
	it("escapes ampersands before angle brackets", () => {
		const body = webhookBody({
			...payload,
			title: "&lt;!channel&gt; & <b>",
			ackUrl: null,
		});
		expect(body.text).toBe("&amp;lt;!channel&amp;gt; &amp; &lt;b&gt;");
	});

	it("always carries a top-level text fallback alongside blocks", () => {
		const body = webhookBody({ ...payload, ackUrl: null });
		expect(body.text).toBe("Walk the dog");
		expect(body.blocks).toHaveLength(1);
	});
});

const BOT_TOKEN = "xoxb-fakefixture-0987654321-AbCdEfGhIjKlMnOpQrStUvWx";
const CHANNEL_ID = "C0A1B2C3D4";
const appConfig = {
	mode: "app",
	botToken: BOT_TOKEN,
	signingSecret: "8f742231b10e8888abcd99yyyzzz85a5",
	channelId: CHANNEL_ID,
};

// docs.slack.dev/reference/methods/chat.postMessage (checked 2026-07-23): the
// method answers HTTP 200 for BOTH outcomes, with `ok` in the JSON envelope.
function apiOk(): Response {
	return new Response(
		JSON.stringify({ ok: true, channel: CHANNEL_ID, ts: "1503435956.000247" }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function apiError(error: string, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify({ ok: false, error }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

describe("slackAdapter app mode", () => {
	it("posts to chat.postMessage with a bearer bot token", async () => {
		const { calls, fetchImpl } = recorder(() => apiOk());
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		// The literal endpoint, not one rebuilt from the module's constants: it is
		// a contract with Slack.
		expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
		expect(calls[0].options?.method).toBe("POST");
		const headers = new Headers(calls[0].options?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
		expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(sentBody(calls[0]).channel).toBe(CHANNEL_ID);
	});

	// The wire shape is a contract with Slack, so the expectation is the literal
	// JSON. An INTERACTIVE button is the whole point of app mode: a link button
	// here would be the dead control the webhook-mode guard exists to prevent.
	it("carries the ack capability in an interactive button", async () => {
		const { calls, fetchImpl } = recorder(() => apiOk());
		await slackAdapter.send(appConfig, payload, context(fetchImpl));

		const blocks = sentBody(calls[0]).blocks as AppBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[1]).toEqual({
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Done" },
					action_id: "ditero_ack",
					value: `c:${ACK_TOKEN}`,
				},
			],
		});
		// Never a url: that is what makes it dispatch an interaction rather than
		// navigate.
		expect(String(calls[0].options?.body)).not.toContain('"url"');
	});

	// Pinned against the DOCUMENTED caps so a future ACK_TOKEN_BYTES change fails
	// here rather than as a 400 in a user's Slack.
	it("fits the capability inside Slack's action_id and value caps", () => {
		const blocks = appBlocks(payload);
		const actions = blocks[1];
		expect(actions.type).toBe("actions");
		const button = actions.type === "actions" ? actions.elements[0] : null;
		expect(button?.value).toBe(`${ACK_VALUE_PREFIX}${ACK_TOKEN}`);
		// 45 = "c:" + a 43-character base64url token, well inside 2000.
		expect(button?.value).toHaveLength(45);
		expect(button?.value.length).toBeLessThanOrEqual(ACTION_VALUE_MAX);
		expect(ACTION_VALUE_MAX).toBe(2_000);
		expect(button?.action_id).toBe(ACK_ACTION_ID);
		expect(ACK_ACTION_ID.length).toBeLessThanOrEqual(ACTION_ID_MAX);
		expect(ACTION_ID_MAX).toBe(255);
	});

	// The scheme is deliberately NOT a criterion here, unlike webhook mode: an
	// interactive button carries the token, never the URL, so nothing navigates
	// and only a value that does not look like a capability is refused. Same
	// rule as the Discord app-mode button.
	it.each([
		["no ack capability", null],
		["an unparseable URL", "not a url"],
		["a last segment that is not a token", "https://app.example.test/ack/x"],
	])("emits no actions block for %s", (_case, ackUrl) => {
		const blocks = appBlocks({ ...payload, ackUrl });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("section");
	});

	it("escapes broadcast pings in app mode too", () => {
		const body = appBody(CHANNEL_ID, {
			...payload,
			title: "<!channel> buy milk",
			ackUrl: null,
		});
		expect(body.text).toBe("&lt;!channel&gt; buy milk");
		expect(JSON.stringify(body)).not.toContain("<!channel>");
	});

	// THE TRAP: chat.postMessage answers HTTP 200 for failures too. A
	// `response.ok` check alone records a revoked token as a delivered reminder.
	it.each([
		["a revoked token", "invalid_auth", 401, "permanent", "client", "auth"],
		[
			"a missing channel",
			"channel_not_found",
			404,
			"permanent",
			"client",
			"not_found",
		],
		["a scope gap", "missing_scope", 403, "permanent", "client", "auth"],
		[
			"an unmodelled error",
			"msg_too_long",
			400,
			"permanent",
			"client",
			"policy",
		],
		["a Slack outage", "service_unavailable", 503, "retry", "server", null],
	])("treats HTTP 200 with %s as a failure", async (_case, code, status, kind, retryClass, errorCode) => {
		const { fetchImpl } = recorder(() => apiError(String(code)));
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, status });
		const decision = classifyRetry(result, 1, 0);
		expect(decision).toMatchObject({ kind, retryClass });
		expect(channelErrorCode(decision, Number(status))).toBe(errorCode);
		// The error code is what an operator triages from.
		expect(result.ok === false ? result.error : "").toContain(String(code));
	});

	it("honours Retry-After on an envelope rate limit", async () => {
		const { fetchImpl } = recorder(() =>
			apiError("ratelimited", { headers: { "Retry-After": "11" } }),
		);
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 11 });
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "throttled",
		});
	});

	it("honours a real 429 status with Retry-After", async () => {
		const { fetchImpl } = recorder(
			() =>
				new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
					status: 429,
					headers: { "Retry-After": "3" },
				}),
		);
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 3 });
	});

	// A 200 with no readable envelope says nothing about delivery, so it must not
	// be reported as one -- and must not be declared permanent either.
	it("does not treat an unparseable 200 body as delivered", async () => {
		const { fetchImpl } = recorder(
			() => new Response("<html>proxy</html>", { status: 200 }),
		);
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result.ok).toBe(false);
		// Never "slack 200": the one line an operator triages from would claim the
		// send worked.
		expect(result.ok === false ? result.error : "").toContain(
			"no envelope code",
		);
		expect(classifyRetry(result, 1, 0)).toMatchObject({ kind: "retry" });
	});

	// The bot token rides in an Authorization header, so no URL redactor covers
	// it: it has to be matched literally wherever a remote can echo it back.
	it.each([
		[
			"an error envelope echoing the token",
			() => apiError(`invalid_auth for ${BOT_TOKEN}`),
		],
		[
			"a transport error quoting the token",
			() => {
				throw new Error(`connect ETIMEDOUT with Bearer ${BOT_TOKEN}`);
			},
		],
		[
			"a policy rejection quoting the token",
			() => {
				throw new OutboundPolicyError(`refused: ${BOT_TOKEN}`);
			},
		],
	])("never leaks the bot token via %s", async (_case, respond) => {
		const { fetchImpl } = recorder(respond as (call: Call) => Response);
		const result = await slackAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(BOT_TOKEN);
		// A prefix too: a redactor that trimmed only the tail would pass above.
		expect(serialized).not.toContain("xoxb-fakefixture");
		expect(serialized).toContain("[REDACTED]");
	});

	// The mirror image of the webhook-mode guard, and it must not weaken it:
	// AckButton is a SEPARATE type, so LinkButton/SlackBlock/WebhookMessageBody
	// stay incapable of expressing an interactive element.
	it("makes a link button unrepresentable in app mode", () => {
		const ack: AckButton = {
			type: "button",
			text: { type: "plain_text", text: "Done" },
			action_id: ACK_ACTION_ID,
			value: `c:${ACK_TOKEN}`,
		};
		// Positive first: the permitted shape must be constructible, or every
		// negative below holds vacuously.
		expect(ack.action_id).toBe(ACK_ACTION_ID);

		// FRESH literals: rejected by excess-property checking alone, so these
		// still pass with `url?: never` deleted. Kept for the containing shapes,
		// where they are the realistic authoring mistake.
		// @ts-expect-error a `url` makes the button navigate instead of dispatching
		const withUrl: AckButton = { ...ack, url: ACK_URL };
		const emitted: readonly AppBlock[] = [
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Done" },
						// @ts-expect-error a link button cannot reach an app-mode actions block
						url: ACK_URL,
					},
				],
			},
		];

		// ASSEMBLED, not fresh: only `url?: never` rejects these, so deleting the
		// field OR widening it to `string` fails typecheck here.
		const widenedUrl = { ...ack, url: ACK_URL };
		// @ts-expect-error `url?: never`, not excess-property checking, rejects this
		const fromWidenedUrl: AckButton = widenedUrl;
		const assembledRow = { type: "actions" as const, elements: [widenedUrl] };
		// @ts-expect-error nor may it reach an actions block
		const fromAssembledRow: readonly AppBlock[] = [assembledRow];
		const assembledBody = {
			channel: CHANNEL_ID,
			text: "x",
			blocks: [assembledRow],
		};
		// @ts-expect-error nor the serialized chat.postMessage body
		const fromAssembledBody: PostMessageBody = assembledBody;

		// The two REQUIRED halves of the dispatch contract. Deleting either field
		// from AckButton makes the matching assembled value assignable.
		const noActionId = {
			type: "button" as const,
			text: { type: "plain_text" as const, text: "Done" },
			value: `c:${ACK_TOKEN}`,
		};
		// @ts-expect-error a button with no action_id dispatches nothing we can route
		const fromNoActionId: AckButton = noActionId;
		const noValue = {
			type: "button" as const,
			text: { type: "plain_text" as const, text: "Done" },
			action_id: ACK_ACTION_ID,
		};
		// @ts-expect-error a button with no value carries no capability
		const fromNoValue: AckButton = noValue;

		// And the two families stay disjoint, which is what keeps the webhook guard
		// intact: neither is assignable to the other's block union.
		const linkOnly: LinkButton = {
			type: "button",
			text: { type: "plain_text", text: "Done" },
			url: ACK_URL,
		};
		const ackRow = { type: "actions" as const, elements: [ack] };
		// @ts-expect-error an interactive button still cannot reach the webhook body
		const intoWebhook: WebhookMessageBody = { text: "x", blocks: [ackRow] };
		const linkRow = { type: "actions" as const, elements: [linkOnly] };
		const intoApp: PostMessageBody = {
			channel: CHANNEL_ID,
			text: "x",
			// @ts-expect-error nor a link button the app-mode body
			blocks: [linkRow],
		};

		expect([
			withUrl,
			emitted,
			fromWidenedUrl,
			fromAssembledRow,
			fromAssembledBody,
			fromNoActionId,
			fromNoValue,
			intoWebhook,
			intoApp,
		]).toHaveLength(9);
	});
});
