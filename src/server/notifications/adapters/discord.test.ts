import { describe, expect, it } from "vitest";
import { redactChannelUrl } from "../../../domain/notification-channel.ts";
import {
	channelErrorCode,
	classifyRetry,
} from "../../../domain/notification-retry.ts";
import {
	OutboundPolicyError,
	type safeFetch,
} from "../../../security/safe-http.ts";
import { ACK_PATH, ackToken } from "../capability.ts";
import {
	type AckButton,
	type AppActionRow,
	ackButtonRow,
	ackCustomId,
	ackLinkRow,
	appRequest,
	type CreateMessageBody,
	CUSTOM_ID_MAX,
	discordAdapter,
	type LinkButton,
	type WebhookActionRow,
	type WebhookExecuteBody,
	webhookRequest,
} from "./discord.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

// Shaped like a real Discord webhook URL: the credential is the LAST PATH
// SEGMENT, not a query parameter, so a redactor that only strips `?...` leaves
// it fully intact and the leak assertions below can actually fail.
const WEBHOOK_SECRET = "aBcD-EfGh_secret_do_not_leak-1234567890";
const WEBHOOK_URL = `https://discord.com/api/webhooks/1234567890123456789/${WEBHOOK_SECRET}`;

const config = { mode: "webhook", webhookUrl: WEBHOOK_URL };

// App mode's credential is a header, not a path segment, so it is a second leak
// surface with its own scrubbing.
const BOT_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.bot_secret_do_not_leak_123";
const CHANNEL_ID = "1234567890123456789";
const appConfig = {
	mode: "app",
	botToken: BOT_TOKEN,
	publicKey: "a".repeat(64),
	channelId: CHANNEL_ID,
};
const MESSAGES_URL = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`;

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

// Discord's documented success for Execute Webhook without `?wait=true`.
function executed(): Response {
	return new Response(null, { status: 204 });
}

describe("discordAdapter", () => {
	it("executes the webhook and treats 204 No Content as delivered", async () => {
		const { calls, fetchImpl } = recorder(() => executed());
		const result = await discordAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		// Exact: a 204 has no body, and an adapter that demanded one would report
		// every successful Discord send as a failure.
		expect(result).toEqual({ ok: true, status: 204 });
		expect(calls).toHaveLength(1);
		expect(calls[0].options?.method).toBe("POST");
		expect(new URL(calls[0].url).origin + new URL(calls[0].url).pathname).toBe(
			WEBHOOK_URL,
		);

		const body = sentBody(calls[0]);
		expect(body.content).toContain("Walk the dog");
		// A task title is user text; `@everyone` in one would otherwise ping the
		// whole server the webhook posts to.
		expect(body.allowed_mentions).toEqual({ parse: [] });
	});

	it("treats a 200 from ?wait=true as delivered too", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json({ id: "1", type: 0 }, { status: 200 }),
		);
		const result = await discordAdapter.send(
			{ ...config, webhookUrl: `${WEBHOOK_URL}?wait=true` },
			payload,
			context(fetchImpl),
		);
		expect(result).toEqual({ ok: true, status: 200 });
	});

	// The wire shape is a contract with Discord, so the expectation is the
	// literal JSON and not values rebuilt from the module's own constants.
	it("sends the ack capability as a link button under with_components", async () => {
		const { calls, fetchImpl } = recorder(() => executed());
		await discordAdapter.send(config, payload, context(fetchImpl));

		expect(new URL(calls[0].url).searchParams.get("with_components")).toBe(
			"true",
		);
		expect(sentBody(calls[0]).components).toEqual([
			{
				type: 1,
				components: [{ type: 2, style: 5, label: "Done", url: ACK_URL }],
			},
		]);
	});

	// The silent-drop hazard: Discord accepts `components` on a plain webhook,
	// answers 204, and removes them -- so "delivered" would be recorded for a
	// notification the user received with no button. Two halves, both fatal on
	// their own: an interactive component, or components sent without the query
	// param that makes Discord respect them at all.
	it("can never emit a dropped component: no custom_id, and never components without with_components", async () => {
		for (const ackUrl of [ACK_URL, null]) {
			const { calls, fetchImpl } = recorder(() => executed());
			await discordAdapter.send(
				config,
				{ ...payload, ackUrl },
				context(fetchImpl),
			);
			const url = new URL(calls[0].url);
			const body = sentBody(calls[0]);
			expect(Object.hasOwn(body, "components")).toBe(
				url.searchParams.get("with_components") === "true",
			);
			if (ackUrl === null) {
				expect(body).not.toHaveProperty("components");
				continue;
			}
			// Only meaningful where components exist: run against `[]` both
			// assertions below hold trivially, which is how this passed while
			// asserting nothing.
			const serialized = JSON.stringify(body.components);
			expect(serialized).toContain("style");
			expect(serialized).not.toContain("custom_id");
			for (const style of serialized.matchAll(/"style":(\d+)/g)) {
				expect(style[1]).toBe("5");
			}
		}
	});

	// The guard itself, not the behaviour: these are compile-time assertions, and
	// `tsc --noEmit` fails on an UNUSED @ts-expect-error. Widening `custom_id` to
	// string, or `style`/`type` to number, therefore breaks typecheck rather than
	// silently permitting an interactive component in webhook mode.
	//
	// Every negative below comes in two shapes, and the second is the one that
	// actually pins the guard. A FRESH object literal is rejected by TypeScript's
	// excess-property check all by itself, so a literal-only assertion keeps its
	// directive "used" even after `custom_id?: never` is DELETED -- it tests
	// excess-property checking, which structural typing gives for free. Only a
	// value assembled elsewhere and then assigned reaches the `?: never` field,
	// and that is also the realistic path: bodies get built by helpers.
	it("makes an interactive component unrepresentable in webhook mode", () => {
		const link: LinkButton = {
			type: 2,
			style: 5,
			label: "Done",
			url: ACK_URL,
		};
		// Positive first: the permitted shape must actually be constructible, or
		// every negative below holds vacuously.
		expect(link).toEqual({ type: 2, style: 5, label: "Done", url: ACK_URL });

		// @ts-expect-error a custom_id is exactly what makes a button interactive
		const withCustomId: LinkButton = { ...link, custom_id: "c:token" };
		// @ts-expect-error style 1 (Primary) is an interactive button style
		const primary: LinkButton = { ...link, style: 1 };

		// Non-fresh, element level: nothing but `custom_id?: never` rejects this.
		const assembled = { ...link, custom_id: "c:token" };
		// @ts-expect-error an interactive button cannot be assigned to a link button
		const fromAssembled: LinkButton = assembled;
		// Non-fresh, row level: the same value one container up, which is how a
		// helper-built row would actually arrive.
		const assembledRow = { type: 1 as const, components: [assembled] };
		// @ts-expect-error a row of interactive buttons is not a webhook row
		const fromAssembledRow: WebhookActionRow = assembledRow;
		const assembledBody = {
			content: "x",
			allowed_mentions: { parse: [] as never[] },
			components: [assembledRow],
		};
		// @ts-expect-error nor can it reach the emitted body
		const fromAssembledBody: WebhookExecuteBody = assembledBody;

		const selectRow: WebhookActionRow = {
			type: 1,
			// @ts-expect-error a string select is interactive and cannot sit in a row
			components: [{ type: 3, custom_id: "pick", options: [] }],
		};
		// The type of the object the adapter actually serializes, so the guard is
		// load-bearing on the emitted body rather than on a decorative alias.
		const emitted: WebhookExecuteBody = {
			content: "x",
			allowed_mentions: { parse: [] },
			components: [
				{
					// @ts-expect-error an interactive button cannot reach the wire body
					components: [{ ...link, custom_id: "c:t" }],
					type: 1,
				},
			],
		};
		const pinging: WebhookExecuteBody = {
			content: "x",
			// @ts-expect-error allowed_mentions cannot be widened back to @everyone
			allowed_mentions: { parse: ["everyone"] },
		};

		expect([
			withCustomId,
			primary,
			fromAssembled,
			fromAssembledRow,
			fromAssembledBody,
			selectRow,
			emitted,
			pinging,
		]).toHaveLength(8);
	});

	it("sends without a button when there is no ack capability", async () => {
		const { calls, fetchImpl } = recorder(() => executed());
		const result = await discordAdapter.send(
			config,
			{ ...payload, ackUrl: null },
			context(fetchImpl),
		);
		expect(result.ok).toBe(true);
		expect(sentBody(calls[0])).not.toHaveProperty("components");
		expect(
			new URL(calls[0].url).searchParams.get("with_components"),
		).toBeNull();
	});

	// Discord reports the wait as FRACTIONAL SECONDS in the 429 body. Read as
	// milliseconds it becomes a 65ms retry that hammers a rate-limited endpoint;
	// multiplied by 1000 it stalls the row for the full 5-minute clamp.
	it("honours a fractional retry_after on a 429", async () => {
		const { fetchImpl } = recorder(() =>
			Response.json(
				{
					message: "You are being rate limited.",
					retry_after: 64.57,
					global: false,
				},
				{ status: 429 },
			),
		);
		const result = await discordAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 64.57 });
		expect(classifyRetry(result, 1, 0)).toEqual({
			kind: "retry",
			delayMs: 64_570,
			retryClass: "throttled",
		});
	});

	// A Cloudflare-level ban answers 429 with HTML and no JSON envelope.
	it("falls back to the Retry-After header when the 429 has no envelope", async () => {
		const { fetchImpl } = recorder(
			() =>
				new Response("<html>banned</html>", {
					status: 429,
					headers: { "Retry-After": "7" },
				}),
		);
		const result = await discordAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ status: 429, retryAfterSec: 7 });
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "throttled",
		});
	});

	// A deleted webhook or a bad token never fixes itself; a 5xx does. Getting
	// this backwards either burns the ~33-minute ladder on a dead channel or
	// abandons a reminder over a momentary Discord outage.
	it.each([
		["a revoked token", 401, "permanent", "client"],
		["a deleted webhook", 404, "permanent", "client"],
		["a malformed body", 400, "permanent", "client"],
		["a gateway error", 502, "retry", "server"],
		["an outage", 500, "retry", "server"],
	])("classifies %s as %s", async (_case, status, kind, retryClass) => {
		const { fetchImpl } = recorder(() =>
			Response.json({ message: "Unknown Webhook", code: 10015 }, { status }),
		);
		const result = await discordAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, status });
		expect(classifyRetry(result, 1, 0)).toMatchObject({ kind, retryClass });
	});

	it("maps a transport throw to a retryable result and never throws", async () => {
		const { fetchImpl } = recorder(() => {
			throw new Error("ECONNRESET");
		});
		const result = await discordAdapter.send(
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
		const result = await discordAdapter.send(
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

	it.each([
		[
			"a non-Discord host",
			{ mode: "webhook", webhookUrl: "https://evil.test/x" },
		],
		["an unknown mode", { mode: "matrix", webhookUrl: WEBHOOK_URL }],
	])("refuses to send for %s", async (_case, unusable) => {
		const { calls, fetchImpl } = recorder(() => executed());
		const result = await discordAdapter.send(
			unusable,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, policyRejected: true });
		// Never a silent downgrade to a buttonless send.
		expect(calls).toHaveLength(0);
	});

	// The webhook token rides in the URL PATH, so any error string that quotes
	// the URL quotes the credential -- and it survives a query-only redactor.
	it.each([
		[
			"an HTTP error envelope",
			() =>
				Response.json(
					{ message: `Invalid Webhook Token ${WEBHOOK_SECRET}`, code: 50027 },
					{ status: 401 },
				),
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
	])("never leaks the webhook token via %s", async (_case, respond) => {
		const { fetchImpl } = recorder(respond as (call: Call) => Response);
		const result = await discordAdapter.send(
			config,
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(WEBHOOK_SECRET);
		// Also a prefix of it: a redactor that trimmed only the trailing digits
		// would pass the assertion above.
		expect(serialized).not.toContain("aBcD-EfGh_secret");
		expect(serialized).toContain("[REDACTED]");
	});

	// The config schema constrains the webhook URL's scheme, host and length, not
	// its path charset. A stored token holding a character `new URL()`
	// percent-encodes leaves the raw and normalized forms different strings, and
	// the provider echoes back the RAW one.
	it("scrubs the stored webhook token in its un-normalized form too", async () => {
		const rawSecret = "raw secret with a space 1234567890";
		const url = `https://discord.com/api/webhooks/1234567890123456789/${rawSecret}`;
		expect(new URL(url).pathname).not.toContain(rawSecret);
		const { fetchImpl } = recorder(() =>
			Response.json(
				{ message: `Invalid Webhook Token ${rawSecret}`, code: 50027 },
				{ status: 401 },
			),
		);
		const result = await discordAdapter.send(
			{ mode: "webhook", webhookUrl: url },
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(rawSecret);
		expect(serialized).not.toContain("raw secret with a space");
		expect(serialized).toContain("[REDACTED]");
	});

	// The rule this adapter relies on lives in the domain redactor, so it is
	// asserted against exactly the URL this adapter emits -- query string
	// included, since that is what carries with_components.
	it("emits a URL that redactChannelUrl fully covers", async () => {
		const { calls, fetchImpl } = recorder(() => executed());
		await discordAdapter.send(config, payload, context(fetchImpl));
		expect(calls[0].url).toContain(WEBHOOK_SECRET);
		expect(redactChannelUrl(calls[0].url)).toBe(
			"https://discord.com/api/webhooks/1234567890123456789/[REDACTED]",
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
		const result = await discordAdapter.send(
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
		const pending = discordAdapter.send(
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
		const { calls, fetchImpl } = recorder(() => executed());
		const allowedPrivateCIDRs = [] as const;
		await discordAdapter.send(
			config,
			payload,
			context(fetchImpl, { allowedPrivateCIDRs }),
		);
		expect(calls[0].options?.allowedPrivateCIDRs).toBe(allowedPrivateCIDRs);
		expect(calls[0].options?.maxResponseBytes).toBe(64 * 1_024);
	});
});

// Tested directly: through send() a dropped guard shows up only as an absent
// `components`, which is indistinguishable from the legitimate no-ack path.
describe("ackLinkRow", () => {
	it("builds a link-style row for a well-formed ack URL", () => {
		expect(ackLinkRow(ACK_URL)).toEqual([
			{
				type: 1,
				components: [{ type: 2, style: 5, label: "Done", url: ACK_URL }],
			},
		]);
	});

	it.each([
		["no ack capability", null],
		["a non-HTTP scheme", `ditero://ack/${ACK_TOKEN}`],
		["an unparseable URL", "not a url"],
	])("yields no button for %s", (_case, ackUrl) => {
		expect(ackLinkRow(ackUrl)).toBeNull();
	});

	// Discord's `url` cap is 512; one over is a 400 that loses the whole
	// notification, not just the button.
	it("yields no button past the 512-character url cap", () => {
		const base = "https://app.example.test/api/notifications/ack/";
		const tooLong = base + "a".repeat(513 - base.length);
		expect(tooLong).toHaveLength(513);
		expect(ackLinkRow(tooLong)).toBeNull();
		// One shorter still passes, so the boundary is pinned rather than "long
		// URLs are rejected".
		expect(ackLinkRow(tooLong.slice(0, 512))).not.toBeNull();
	});
});

describe("webhookRequest", () => {
	it("keeps a thread_id the operator pasted and adds with_components", () => {
		const { url } = webhookRequest(`${WEBHOOK_URL}?thread_id=42`, payload);
		const params = new URL(url).searchParams;
		expect(params.get("thread_id")).toBe("42");
		expect(params.get("with_components")).toBe("true");
	});

	// A pasted `with_components=true` must not make a componentless send claim
	// component support, and must not be able to desync from the body.
	it("strips a pasted with_components when there is no button", () => {
		const { url, body } = webhookRequest(
			`${WEBHOOK_URL}?with_components=true`,
			{
				...payload,
				ackUrl: null,
			},
		);
		expect(new URL(url).searchParams.get("with_components")).toBeNull();
		expect(body).not.toHaveProperty("components");
	});

	it("caps the content at Discord's 2000-character limit", () => {
		const { body } = webhookRequest(WEBHOOK_URL, {
			...payload,
			title: "x".repeat(5_000),
		});
		// Exact: `toBeLessThanOrEqual` also passes if the content truncates to "".
		expect(body.content).toHaveLength(2_000);
	});
});

describe("discordAdapter app mode", () => {
	// Verified against Discord's docs on 2026-07-22: Create Message is
	// `POST /channels/{channel.id}/messages` under `https://discord.com/api`,
	// authenticated with `Authorization: Bot <token>`, and returns the message
	// object with a 200 -- not the webhook path, and not a 204.
	it("posts to the bot API as the bot and treats 200 as delivered", async () => {
		const { calls, fetchImpl } = recorder(() =>
			Response.json({ id: "9", channel_id: CHANNEL_ID }, { status: 200 }),
		);
		const result = await discordAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);

		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(MESSAGES_URL);
		expect(calls[0].options?.method).toBe("POST");
		const headers = new Headers(calls[0].options?.headers);
		// The exact scheme, not a bearer: Discord rejects `Bearer <bot token>`.
		expect(headers.get("authorization")).toBe(`Bot ${BOT_TOKEN}`);
		expect(headers.get("content-type")).toBe("application/json");
	});

	// The whole point of app mode: a button that dispatches an interaction and
	// acks in place, rather than the link button webhook mode is limited to.
	it("sends the ack capability as an interactive custom_id button", async () => {
		const { calls, fetchImpl } = recorder(() =>
			Response.json({ id: "9" }, { status: 200 }),
		);
		await discordAdapter.send(appConfig, payload, context(fetchImpl));

		const body = sentBody(calls[0]);
		expect(body.components).toEqual([
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: "Done", custom_id: `c:${ACK_TOKEN}` },
				],
			},
		]);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		// A `url` would make it a link button, which dispatches nothing -- the dead
		// button app mode exists to avoid.
		expect(JSON.stringify(body.components)).not.toContain('"url"');
	});

	it("sends without a button when there is no ack capability", async () => {
		const { calls, fetchImpl } = recorder(() =>
			Response.json({ id: "9" }, { status: 200 }),
		);
		await discordAdapter.send(
			appConfig,
			{ ...payload, ackUrl: null },
			context(fetchImpl),
		);
		expect(sentBody(calls[0])).not.toHaveProperty("components");
	});

	// The mirror of the webhook-mode guard, and compile-time like it: an unused
	// expect-error directive fails `tsc --noEmit`, so relaxing `custom_id` to
	// optional, `url` away from `never`, or `style` to number breaks typecheck
	// rather than silently letting app mode emit a button nobody can press.
	it("makes a link-only button unrepresentable in app mode", () => {
		const button: AckButton = {
			type: 2,
			style: 3,
			label: "Done",
			custom_id: `c:${ACK_TOKEN}`,
		};
		// Positive first, or every negative below holds vacuously.
		expect(button.custom_id).toBe(`c:${ACK_TOKEN}`);

		// @ts-expect-error a url is exactly what makes a button non-interactive
		const linky: AckButton = { ...button, url: ACK_URL };
		// @ts-expect-error style 5 (Link) dispatches no interaction
		const link: AckButton = { ...button, style: 5 };
		const { custom_id: _dropped, ...noCustomId } = button;
		// @ts-expect-error a button without a custom_id cannot ack anything
		const inert: AckButton = noCustomId;

		// Non-fresh, element and row level: a fresh literal is rejected by
		// excess-property checking whether or not `url?: never` exists, so only
		// these two fail once it is deleted. See the webhook-mode note above.
		const assembled = { ...button, url: ACK_URL };
		// @ts-expect-error `url?: never`, not excess-property checking, rejects this
		const fromAssembled: AckButton = assembled;
		const assembledRow = { type: 1 as const, components: [assembled] };
		// @ts-expect-error nor can a link button ride in an app-mode row
		const fromAssembledRow: AppActionRow = assembledRow;
		const assembledBody = {
			content: "x",
			allowed_mentions: { parse: [] as never[] },
			components: [assembledRow],
		};
		// @ts-expect-error nor reach the emitted body
		const fromAssembledBody: CreateMessageBody = assembledBody;
		const row: AppActionRow = {
			type: 1,
			// @ts-expect-error webhook mode's link button cannot sit in an app row
			components: [{ type: 2, style: 5, label: "Done", url: ACK_URL }],
		};
		const emitted: CreateMessageBody = {
			content: "x",
			// @ts-expect-error allowed_mentions cannot be widened back to @everyone
			allowed_mentions: { parse: ["everyone"] },
		};

		expect([
			linky,
			link,
			inert,
			fromAssembled,
			fromAssembledRow,
			fromAssembledBody,
			row,
			emitted,
		]).toHaveLength(8);
	});

	// 403 "Missing Access" is the ordinary misconfiguration -- the bot was never
	// invited to the channel -- and must reach the operator as a credential/access
	// problem, not as a generic policy rejection that reads like an egress block.
	it.each([
		["a revoked bot token", 401, "auth"],
		["a bot missing channel access", 403, "auth"],
		["a channel that does not exist", 404, "not_found"],
	])("classifies %s as permanent %s", async (_case, status, code) => {
		const { fetchImpl } = recorder(() =>
			Response.json({ message: "Missing Access", code: 50001 }, { status }),
		);
		const result = await discordAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(result).toMatchObject({ ok: false, status });
		const decision = classifyRetry(result, 1, 0);
		expect(decision).toMatchObject({ kind: "permanent", retryClass: "client" });
		expect(channelErrorCode(decision, status)).toBe(code);
	});

	it("retries a bot API 5xx", async () => {
		const { fetchImpl } = recorder(() => new Response("", { status: 502 }));
		const result = await discordAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		expect(classifyRetry(result, 1, 0)).toMatchObject({
			kind: "retry",
			retryClass: "server",
		});
	});

	// The bot token rides in an Authorization header, so nothing in the URL
	// redactor covers it: it has to be matched literally.
	it.each([
		[
			"an error envelope quoting it",
			() =>
				Response.json(
					{ message: `401: Unauthorized ${BOT_TOKEN}`, code: 0 },
					{ status: 401 },
				),
		],
		[
			"a transport error quoting it",
			() => {
				throw new Error(`socket hang up (Bot ${BOT_TOKEN})`);
			},
		],
		[
			"a policy rejection quoting it",
			() => {
				throw new OutboundPolicyError(`blocked: Bot ${BOT_TOKEN}`);
			},
		],
	])("never leaks the bot token via %s", async (_case, respond) => {
		const { fetchImpl } = recorder(respond as (call: Call) => Response);
		const result = await discordAdapter.send(
			appConfig,
			payload,
			context(fetchImpl),
		);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(BOT_TOKEN);
		// A prefix too: trimming only the trailing half would pass the assertion
		// above while leaking the rest.
		expect(serialized).not.toContain("bot_secret_do_not_leak");
		expect(serialized).toContain("[REDACTED]");
	});
});

describe("ackCustomId", () => {
	// The capability must fit the field, or the button silently cannot exist.
	// Asserted against a REAL minted token, so growing ACK_TOKEN_BYTES fails here
	// rather than in a user's Discord.
	it("fits a freshly minted capability inside Discord's 100-character cap", () => {
		const customId = ackCustomId(
			`https://app.example.test${ACK_PATH}/${ackToken()}`,
		);
		expect(customId).not.toBeNull();
		expect(customId).toHaveLength(45);
		expect((customId as string).length).toBeLessThanOrEqual(CUSTOM_ID_MAX);
	});

	// Pins the boundary rather than "long tokens are rejected".
	it("yields no button one character past the cap", () => {
		const base = `https://app.example.test${ACK_PATH}/`;
		const longest = "a".repeat(CUSTOM_ID_MAX - "c:".length);
		expect(ackCustomId(base + longest)).toHaveLength(CUSTOM_ID_MAX);
		expect(ackCustomId(`${base + longest}a`)).toBeNull();
	});

	it.each([
		["no ack capability", null],
		["an unparseable URL", "not a url"],
		["a segment that is not a capability token", "https://app.test/ack/no.pe"],
		["a segment too short to be one", "https://app.test/ack/abc"],
	])("yields no button for %s", (_case, ackUrl) => {
		expect(ackCustomId(ackUrl)).toBeNull();
		expect(ackButtonRow(ackUrl)).toBeNull();
	});
});

describe("appRequest", () => {
	it("targets the configured channel and caps the content", () => {
		const { url, body } = appRequest(CHANNEL_ID, {
			...payload,
			title: "x".repeat(5_000),
		});
		expect(url).toBe(MESSAGES_URL);
		expect(body.content).toHaveLength(2_000);
	});
});
