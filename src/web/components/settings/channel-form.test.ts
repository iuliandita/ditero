import { describe, expect, it } from "vitest";
import {
	type ChannelKind,
	channelConfigSchema,
	isPublicChannelField,
	MASKED,
} from "../../../domain/notification-channel.ts";
import {
	appModeDisabled,
	CHANNEL_MODES,
	CHANNEL_ORDER,
	type ChannelCapabilities,
	type ChannelHealthRow,
	type ChannelMode,
	channelFields,
	channelHealth,
	DEFAULT_CAPABILITIES,
	formConfig,
	formValues,
	hasModes,
	type InteractionsUrls,
	interactionsUrlFor,
	rowFrozen,
	rowUnavailable,
	rowWarnings,
	type StoredChannel,
	SUMMARY_FIELD,
	summaryDetail,
} from "./channel-form.ts";

const T0 = 1_700_000_000_000;

function caps(patch: Partial<ChannelCapabilities> = {}): ChannelCapabilities {
	return {
		ackBaseUrl: true,
		email: true,
		telegramTransport: "poll",
		telegramWebhookConfigurable: true,
		...patch,
	};
}

function stored(
	kind: ChannelKind,
	config: Record<string, unknown>,
	verifiedAt: number | null = null,
	ackVerifiedAt: number | null = null,
): StoredChannel {
	return { kind, enabled: true, verifiedAt, ackVerifiedAt, config };
}

function healthRow(patch: Partial<ChannelHealthRow> = {}): ChannelHealthRow {
	return {
		verifiedAt: null,
		ackVerifiedAt: null,
		lastErrorAt: null,
		lastErrorCode: null,
		...patch,
	};
}

// Every (kind, mode) pair the UI can render, so a gate that only breaks for one
// channel cannot hide behind a single-kind fixture.
type Case = { kind: ChannelKind; mode: ChannelMode };
const CASES: Case[] = CHANNEL_ORDER.flatMap((kind): Case[] =>
	hasModes(kind)
		? [
				{ kind, mode: "webhook" },
				{ kind, mode: "app" },
			]
		: [{ kind, mode: "webhook" }],
);

describe("channelFields", () => {
	it.each(CASES)("derives secrecy from PUBLIC_FIELDS for $kind/$mode", (c) => {
		const fields = channelFields(c.kind, c.mode);
		expect(fields.length).toBeGreaterThan(0);
		for (const field of fields) {
			expect(field.secret).toBe(!isPublicChannelField(c.kind, field.key));
		}
	});

	it("marks every credential secret and every identifier public", () => {
		const secretsOf = (kind: ChannelKind, mode: ChannelMode) =>
			channelFields(kind, mode)
				.filter((f) => f.secret)
				.map((f) => f.key)
				.sort();
		expect(secretsOf("ntfy", "webhook")).toEqual(["token"]);
		expect(secretsOf("telegram", "webhook")).toEqual(["botToken"]);
		expect(secretsOf("discord", "webhook")).toEqual(["webhookUrl"]);
		expect(secretsOf("discord", "app")).toEqual(["botToken", "publicKey"]);
		expect(secretsOf("slack", "webhook")).toEqual(["webhookUrl"]);
		expect(secretsOf("slack", "app")).toEqual(["botToken", "signingSecret"]);
		expect(secretsOf("email", "webhook")).toEqual([]);
	});

	it("never offers `mode` as a text input", () => {
		for (const c of CASES) {
			expect(channelFields(c.kind, c.mode).map((f) => f.key)).not.toContain(
				"mode",
			);
		}
	});
});

// SIMPLE_FIELDS/MODE_FIELDS used to be a hand-maintained second copy of every
// config schema's key set: masking was single-sourced, the SHAPE was not, so a
// required field added to a schema was silently omitted from the POST and came
// back as an unactionable "invalid channel config".
describe("field keys track the config schemas", () => {
	function schemaKeys(kind: ChannelKind, mode: ChannelMode): string[] {
		const schema = channelConfigSchema[kind] as unknown as {
			shape?: Record<string, unknown>;
			options?: {
				shape: Record<
					string,
					{ safeParse: (v: unknown) => { success: boolean } }
				>;
			}[];
		};
		const shape =
			schema.options?.find((o) => o.shape.mode.safeParse(mode).success)
				?.shape ?? schema.shape;
		return Object.keys(shape ?? {}).filter((key) => key !== "mode");
	}

	it.each(CASES)("matches the schema key set for $kind/$mode", (c) => {
		expect(channelFields(c.kind, c.mode).map((f) => f.key)).toEqual(
			schemaKeys(c.kind, c.mode),
		);
	});

	it("takes optionality from the schema too", () => {
		const optional = (kind: ChannelKind, mode: ChannelMode) =>
			channelFields(kind, mode)
				.filter((f) => f.optional)
				.map((f) => f.key);
		expect(optional("ntfy", "webhook")).toEqual(["token"]);
		for (const c of CASES) {
			if (c.kind === "ntfy") continue;
			expect(optional(c.kind, c.mode)).toEqual([]);
		}
	});

	it("renders nothing for a mode a kind does not have", () => {
		expect(channelFields("ntfy", "app")).toEqual(
			channelFields("ntfy", "webhook"),
		);
		expect(CHANNEL_MODES).toEqual(["webhook", "app"]);
	});
});

describe("summaryDetail", () => {
	it("shows public config for every kind", () => {
		expect(summaryDetail("ntfy", { topic: "meds", token: MASKED })).toEqual({
			kind: "text",
			value: "meds",
		});
		expect(summaryDetail("telegram", { chatId: "4412238" })).toEqual({
			kind: "text",
			value: "4412238",
		});
		expect(summaryDetail("email", { address: "me@example.com" })).toEqual({
			kind: "text",
			value: "me@example.com",
		});
	});

	// The discriminant is an enum, not a display string: rendering it raw put
	// "webhook" in the collapsed row instead of "Webhook mode".
	it("hands the mode discriminant back as a mode, never as raw text", () => {
		expect(summaryDetail("discord", { mode: "webhook" })).toEqual({
			kind: "mode",
			value: "webhook",
		});
		expect(summaryDetail("slack", { mode: "app" })).toEqual({
			kind: "mode",
			value: "app",
		});
		expect(summaryDetail("discord", { mode: "sideways" })).toBeNull();
	});

	// The invariant test above asserts SUMMARY_FIELD against isPublicChannelField
	// directly and never calls summaryDetail, so deleting summaryDetail's own
	// guard left every test green. The guard only fires for a SUMMARY_FIELD
	// pointing at a credential -- the exact regression it exists to survive -- so
	// the only way to drive it is to make the map point at one.
	it("renders nothing when SUMMARY_FIELD points at a credential", () => {
		const original = SUMMARY_FIELD.ntfy;
		SUMMARY_FIELD.ntfy = "token";
		try {
			expect(summaryDetail("ntfy", { token: "tk_a_real_secret" })).toBeNull();
		} finally {
			SUMMARY_FIELD.ntfy = original;
		}
	});

	it("only ever summarises a field the mask hands back", () => {
		for (const kind of CHANNEL_ORDER) {
			expect(isPublicChannelField(kind, SUMMARY_FIELD[kind])).toBe(true);
		}
	});

	it("never renders a masked placeholder", () => {
		for (const kind of CHANNEL_ORDER) {
			const config: Record<string, unknown> = {
				topic: MASKED,
				chatId: MASKED,
				mode: MASKED,
				address: MASKED,
			};
			expect(summaryDetail(kind, config)).toBeNull();
		}
	});
});

describe("formValues", () => {
	it("carries the stored masked secret so it can be saved untouched", () => {
		const row = stored("telegram", { botToken: MASKED, chatId: "42" });
		expect(formValues("telegram", "webhook", row)).toEqual({
			botToken: MASKED,
			chatId: "42",
		});
	});

	it("blanks the other mode's fields on a mode switch", () => {
		// `config` is server JSON, not a parsed union, so the fixture carries a
		// key from the mode it is NOT in. Without that the assertion passes on a
		// build with no mode guard at all -- the missing key blanks itself.
		const row = stored("discord", {
			mode: "webhook",
			webhookUrl: MASKED,
			botToken: MASKED,
			channelId: "999",
		});
		// The trap this exists to prevent: `***` in botToken reads as "a bot
		// token is stored" when none is.
		expect(formValues("discord", "app", row)).toEqual({
			botToken: "",
			publicKey: "",
			channelId: "",
		});
		expect(formValues("discord", "webhook", row)).toEqual({
			webhookUrl: MASKED,
		});
	});

	it("carries app-mode fields when the stored row is already in app mode", () => {
		const row = stored("slack", {
			mode: "app",
			botToken: MASKED,
			signingSecret: MASKED,
			channelId: "C123",
		});
		expect(formValues("slack", "app", row)).toEqual({
			botToken: MASKED,
			signingSecret: MASKED,
			channelId: "C123",
		});
		expect(formValues("slack", "webhook", row)).toEqual({ webhookUrl: "" });
	});

	it("renders blank with no stored row", () => {
		expect(formValues("ntfy", "webhook", null)).toEqual({
			serverUrl: "",
			topic: "",
			token: "",
		});
	});
});

describe("formConfig", () => {
	it("omits empty fields and carries the mode discriminant", () => {
		expect(
			formConfig("ntfy", "webhook", {
				serverUrl: "https://ntfy.sh",
				topic: "meds",
				token: "",
			}),
		).toEqual({ serverUrl: "https://ntfy.sh", topic: "meds" });
		expect(
			formConfig("discord", "app", {
				botToken: "t",
				publicKey: "k",
				channelId: "1",
			}),
		).toEqual({ mode: "app", botToken: "t", publicKey: "k", channelId: "1" });
	});

	it("never sends a field belonging to the other mode", () => {
		expect(
			formConfig("slack", "webhook", {
				webhookUrl: "https://hooks.slack.com/x",
				botToken: "leaked",
			}),
		).toEqual({ mode: "webhook", webhookUrl: "https://hooks.slack.com/x" });
	});
});

describe("channelHealth", () => {
	const row = stored("ntfy", { topic: "t" });

	it("is unconfigured with no stored row", () => {
		expect(channelHealth(null, null).state).toBe("unconfigured");
	});

	it("is untested with a stored row and no verification", () => {
		expect(channelHealth(row, null).state).toBe("untested");
	});

	it("is verified from the synced row", () => {
		expect(channelHealth(row, healthRow({ verifiedAt: T0 }))).toEqual({
			state: "verified",
			at: T0,
			ackProven: false,
		});
	});

	it("reports a credential that was verified and is now failing", () => {
		expect(
			channelHealth(
				row,
				healthRow({
					verifiedAt: T0,
					lastErrorAt: T0 + 1_000,
					lastErrorCode: "auth",
				}),
			),
		).toEqual({
			state: "failing",
			code: "auth",
			at: T0 + 1_000,
			verifiedAt: T0,
		});
	});

	// "Verified" is a claim about the inbound leg. Only a redeemed capability
	// proves it; a send the provider accepted proves half a round trip.
	it("is ack-proven only once ack_verified_at is set", () => {
		expect(
			channelHealth(row, healthRow({ verifiedAt: T0, ackVerifiedAt: T0 + 5 })),
		).toEqual({ state: "verified", at: T0, ackProven: true });
		// Falls back to the API row when the synced one has not arrived.
		expect(channelHealth(stored("ntfy", { topic: "t" }, T0, T0), null)).toEqual(
			{
				state: "verified",
				at: T0,
				ackProven: true,
			},
		);
	});

	it("keeps verified when the last delivery succeeded after the error", () => {
		expect(
			channelHealth(
				row,
				healthRow({
					verifiedAt: T0 + 1_000,
					lastErrorAt: T0,
					lastErrorCode: "transport",
				}),
			),
		).toEqual({ state: "verified", at: T0 + 1_000, ackProven: false });
	});
});

describe("capability gating", () => {
	it("disables app mode only without a public base URL", () => {
		expect(appModeDisabled(caps({ ackBaseUrl: false }))).toBe(true);
		expect(appModeDisabled(caps({ ackBaseUrl: true }))).toBe(false);
	});

	it("disables only the email row, and only without SMTP", () => {
		for (const kind of CHANNEL_ORDER) {
			expect(rowUnavailable(kind, caps())).toBeNull();
			expect(rowUnavailable(kind, caps({ email: false }))).toBe(
				kind === "email" ? "email_smtp_missing" : null,
			);
		}
	});

	it("warns on a stored app-mode row once the public URL is gone", () => {
		const app = stored("discord", { mode: "app", channelId: "1" });
		const webhook = stored("discord", { mode: "webhook" });
		expect(rowWarnings("discord", caps({ ackBaseUrl: false }), app)).toEqual([
			"app_mode_no_public_url",
		]);
		expect(
			rowWarnings("discord", caps({ ackBaseUrl: false }), webhook),
		).toEqual([]);
		expect(rowWarnings("discord", caps(), app)).toEqual([]);
	});

	// Distinct from the row's own unavailable line, which says the same thing:
	// a stored row used to render the identical sentence twice.
	it("warns on a configured email row once SMTP is gone", () => {
		const row = stored("email", { address: "me@example.com" });
		expect(rowWarnings("email", caps({ email: false }), row)).toEqual([
			"email_delivery_paused",
		]);
		expect(rowWarnings("email", caps({ email: false }), row)).not.toContain(
			rowUnavailable("email", caps({ email: false })),
		);
		expect(rowWarnings("email", caps(), row)).toEqual([]);
	});

	it("warns only when Telegram is set to webhook and the transport is dead", () => {
		expect(
			rowWarnings(
				"telegram",
				caps({
					telegramTransport: "webhook",
					telegramWebhookConfigurable: false,
				}),
				null,
			),
		).toEqual(["telegram_webhook_unreachable"]);
		expect(
			rowWarnings(
				"telegram",
				caps({ telegramTransport: "poll", telegramWebhookConfigurable: false }),
				null,
			),
		).toEqual([]);
		expect(
			rowWarnings(
				"telegram",
				caps({
					telegramTransport: "webhook",
					telegramWebhookConfigurable: true,
				}),
				null,
			),
		).toEqual([]);
	});

	// The fail-closed default the whole capability contract rests on: a slow load
	// must refuse app mode and the email row rather than offer a control the
	// server will reject. Untested, flipping either to true survived everything.
	it("defaults every optimistic capability to off", () => {
		expect(DEFAULT_CAPABILITIES.ackBaseUrl).toBe(false);
		expect(DEFAULT_CAPABILITIES.email).toBe(false);
		expect(appModeDisabled(DEFAULT_CAPABILITIES)).toBe(true);
		expect(rowUnavailable("email", DEFAULT_CAPABILITIES)).toBe(
			"email_smtp_missing",
		);
		// Poll needs no public URL, so it is the only transport assumable here.
		expect(DEFAULT_CAPABILITIES.telegramTransport).toBe("poll");
		expect(rowWarnings("telegram", DEFAULT_CAPABILITIES, null)).toEqual([]);
	});

	// Marked unavailable is not frozen: a user whose operator dropped SMTP must
	// still be able to expand, inspect and remove a stored email channel.
	it("freezes an unavailable row only while nothing is stored", () => {
		const row = stored("email", { address: "me@example.com" });
		expect(
			rowFrozen(rowUnavailable("email", caps({ email: false })), null),
		).toBe(true);
		expect(
			rowFrozen(rowUnavailable("email", caps({ email: false })), row),
		).toBe(false);
		expect(rowFrozen(rowUnavailable("email", caps()), null)).toBe(false);
	});

	it("offers an interactions URL only for the two moded kinds", () => {
		const urls = { discord: "https://x/d", slack: "https://x/s" };
		// Same reason as the mode-switch fixture: the payload is server JSON. A
		// map with only the two expected keys passes even with no kind guard,
		// because the absent key already yields undefined.
		const overreaching = {
			...urls,
			ntfy: "https://x/n",
			telegram: "https://x/t",
			email: "https://x/e",
		} as InteractionsUrls;
		for (const kind of CHANNEL_ORDER) {
			expect(interactionsUrlFor(kind, overreaching)).toBe(
				hasModes(kind) ? urls[kind] : null,
			);
		}
		expect(interactionsUrlFor("discord", null)).toBeNull();
	});
});
