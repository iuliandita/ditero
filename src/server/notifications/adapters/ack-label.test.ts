import { describe, expect, it } from "vitest";
import { LOCALES } from "../../../domain/locale.ts";
import type { safeFetch } from "../../../security/safe-http.ts";
import { ackButtonRow, ackLinkRow } from "./discord.ts";
import { emailAdapter } from "./email.ts";
import { ntfyAdapter } from "./ntfy.ts";
import { appBlocks, messageBlocks } from "./slack.ts";
import { telegramAdapter } from "./telegram.ts";
import type { AdapterContext, ChannelPayload } from "./types.ts";

// Catalog literals, not m() on both sides: an assertion built from the same
// message function it is checking passes against an emptied catalog.
const ACK: Record<string, string> = {
	en: "Done",
	de: "Erledigt",
	es: "Hecho",
	fr: "Fait",
	ro: "Gata",
	ar: "تم",
};
// The token segment must satisfy each adapter's TOKEN_SEGMENT (>= 16 chars),
// or the button is dropped and every assertion below would read as a missing
// translation rather than a rejected URL.
const ACK_URL =
	"https://app.example.test/api/notifications/ack/s6Ag1FaJ0k_lZ-3Qb2Xr4tYu6iOp8AsDfGhJkLzXcVb";

const payload = (locale: string): ChannelPayload => ({
	title: "Walk the dog",
	body: "body",
	urgent: false,
	ackUrl: ACK_URL,
	locale: locale as "en",
});

function context(fetchImpl: typeof safeFetch): AdapterContext {
	return {
		allowedPrivateCIDRs: [],
		deadlineMs: 5_000,
		signal: new AbortController().signal,
		fetch: fetchImpl,
	};
}

function recorder(status = 200) {
	const calls: { url: string; options: Parameters<typeof safeFetch>[1] }[] = [];
	const fetchImpl = (async (url, options = {}) => {
		calls.push({ url: String(url), options });
		return new Response(JSON.stringify({ ok: true }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof safeFetch;
	return { calls, fetchImpl };
}

describe("channels carrying the label in a JSON body", () => {
	it.each(LOCALES)("slack webhook button is in %s", (locale) => {
		const blocks = messageBlocks(payload(locale)) as unknown as {
			elements?: { text: { text: string } }[];
		}[];
		const actions = blocks.find((b) => b.elements);
		expect(actions?.elements?.[0].text.text).toBe(ACK[locale]);
	});

	it.each(LOCALES)("slack app button is in %s", (locale) => {
		const blocks = appBlocks(payload(locale)) as unknown as {
			elements?: { text: { text: string } }[];
		}[];
		const actions = blocks.find((b) => b.elements);
		expect(actions?.elements?.[0].text.text).toBe(ACK[locale]);
	});

	it.each(LOCALES)("discord link button is in %s", (locale) => {
		const rows = ackLinkRow(ACK_URL, locale);
		expect(rows?.[0].components[0].label).toBe(ACK[locale]);
	});

	it.each(LOCALES)("discord app button is in %s", (locale) => {
		const rows = ackButtonRow(ACK_URL, locale);
		expect(rows?.[0].components[0].label).toBe(ACK[locale]);
	});

	it.each(LOCALES)("telegram inline keyboard is in %s", async (locale) => {
		const { calls, fetchImpl } = recorder();
		await telegramAdapter.send(
			{ botToken: "123:abc", chatId: "42" },
			payload(locale),
			context(fetchImpl),
		);
		const body = JSON.parse(String(calls[0].options?.body)) as {
			reply_markup: { inline_keyboard: { text: string }[][] };
		};
		expect(body.reply_markup.inline_keyboard[0][0].text).toBe(ACK[locale]);
	});
});

// The email prefix is a sentence, not a button label, so it is its own key.
describe("email ack prefix", () => {
	it.each([
		["en", "Mark it done:"],
		["de", "Als erledigt markieren:"],
		["fr", "Marquer comme fait :"],
		["ar", "وضع علامة كمنجز:"],
	])("renders in %s", async (locale, prefix) => {
		let sent = "";
		await emailAdapter.send({ address: "to@t.dev" }, payload(locale), {
			allowedPrivateCIDRs: [],
			deadlineMs: 5_000,
			signal: new AbortController().signal,
			mailer: {
				send: async (message: { text: string }) => {
					sent = message.text;
					return { ok: true as const };
				},
			} as never,
		});
		expect(sent).toContain(`${prefix} ${ACK_URL}`);
	});
});

// ntfy is the constrained one: the label rides in an HTTP header, whose value
// serializes as latin-1. A raw Arabic label throws out of `new Headers()`,
// which the adapter catches and reports as a PERMANENT config error -- delivery
// dies silently rather than degrading. ntfy decodes RFC 2047 on every header it
// reads before parsing it (server/util.go readParam -> readHeaderParam ->
// maybeDecodeHeader), so the value is encoded when it is not already ASCII.
describe("ntfy Actions header", () => {
	async function actionsHeader(locale: string): Promise<string | null> {
		const { calls, fetchImpl } = recorder();
		const result = await ntfyAdapter.send(
			{ serverUrl: "https://ntfy.example.test", topic: "t", token: "tk" },
			payload(locale),
			context(fetchImpl),
		);
		// A throw inside buildHeaders never reaches fetch: it returns permanent
		// and calls stays empty, so assert the send actually happened.
		expect(
			result.ok,
			`send failed for ${locale}: ${JSON.stringify(result)}`,
		).toBe(true);
		return new Headers(calls[0].options?.headers).get("Actions");
	}

	// The regression that matters: not "the label is translated" but "the header
	// is constructible at all". Without the encoding this fails for ar with a
	// permanent "unusable channel config".
	it.each(LOCALES)("builds a sendable header in %s", async (locale) => {
		const value = await actionsHeader(locale);
		// Non-empty is the whole claim: the send above already proves the header
		// was constructible, which is what breaks without the encoding.
		expect(value).toBeTruthy();
	});

	// An ASCII label must stay on the wire as-is: encoding everything would cost
	// ~33% length and make the header unreadable in a proxy log for no gain.
	it.each(["en", "de", "es", "fr", "ro"])("%s stays unencoded", async (l) => {
		const value = await actionsHeader(l);
		expect(value).toContain(`"${ACK[l]}"`);
		expect(value).not.toContain("=?UTF-8?B?");
	});

	it("encodes the Arabic label as one RFC 2047 word", async () => {
		const value = await actionsHeader("ar");
		const match = (value ?? "").match(/^=\?UTF-8\?B\?(.+)\?=$/);
		expect(match, `not an encoded word: ${value}`).not.toBeNull();
		// Decoded independently of the encoder, and asserted whole: ntfy decodes
		// the entire value before action.Parse sees it, so what must round-trip is
		// the complete action string, quotes included.
		const decoded = Buffer.from(match?.[1] ?? "", "base64").toString("utf8");
		expect(decoded).toBe(
			`http, "${ACK.ar}", "${ACK_URL}", method=POST, clear=true`,
		);
	});
});
