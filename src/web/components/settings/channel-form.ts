// Rendering logic for the five channel rows, kept pure so the capability-gated
// states are testable without a DOM.
//
// The one rule this module exists to hold: what is secret is derived from
// `isPublicChannelField` -- the same allow-list the server encrypts and masks
// with -- never from a second list kept here.
import {
	type ChannelKind,
	channelConfigKeys,
	isPublicChannelField,
	MASKED,
} from "../../../domain/notification-channel.ts";
import type { ChannelErrorCode } from "../../../domain/notification-retry.ts";

export const CHANNEL_ORDER = [
	"ntfy",
	"telegram",
	"discord",
	"slack",
	"email",
] as const satisfies readonly ChannelKind[];

export type ChannelMode = "webhook" | "app";
export const CHANNEL_MODES: readonly ChannelMode[] = ["webhook", "app"];

export type ModedKind = "discord" | "slack";

export function hasModes(kind: ChannelKind): kind is ModedKind {
	return kind === "discord" || kind === "slack";
}

// Booleans and enums only: the deployment's env values never reach the client.
// The interactions URL is carried separately (see InteractionsUrls) because the
// user has to paste it into the provider, so it is public by construction.
export type ChannelCapabilities = {
	ackBaseUrl: boolean;
	email: boolean;
	telegramTransport: "poll" | "webhook";
	telegramWebhookConfigurable: boolean;
};

export type InteractionsUrls = Record<ModedKind, string>;

// Assumed until the API answers: refusing app mode and disabling email on a
// slow load is the safe direction -- the alternative offers a control the
// server will reject.
export const DEFAULT_CAPABILITIES: ChannelCapabilities = {
	ackBaseUrl: false,
	email: false,
	telegramTransport: "poll",
	telegramWebhookConfigurable: true,
};

export type StoredChannel = {
	kind: ChannelKind;
	enabled: boolean;
	verifiedAt: number | null;
	ackVerifiedAt: number | null;
	config: Record<string, unknown>;
};

// The Zero-synced half of the row. `config` never syncs; health does.
export type ChannelHealthRow = {
	verifiedAt: number | null;
	ackVerifiedAt: number | null;
	lastErrorAt: number | null;
	lastErrorCode: ChannelErrorCode | null;
};

const INPUT_TYPES = new Map<string, FieldSpec["type"]>([
	["serverUrl", "url"],
	["webhookUrl", "url"],
	["address", "email"],
]);

export type FieldSpec = {
	key: string;
	secret: boolean;
	optional: boolean;
	type: "text" | "url" | "email";
};

// Keys and optionality come from the Zod config schema, secrecy from the same
// PUBLIC_FIELDS allow-list the server encrypts with. Nothing about a channel's
// shape is restated here. `mode` is public but never a text input -- it is the
// radio group, and channelConfigKeys drops it.
export function channelFields(
	kind: ChannelKind,
	mode: ChannelMode,
): FieldSpec[] {
	return channelConfigKeys(kind, mode).map(({ key, optional }) => ({
		key,
		secret: !isPublicChannelField(kind, key),
		optional,
		type: INPUT_TYPES.get(key) ?? "text",
	}));
}

export function storedMode(stored: StoredChannel | null): ChannelMode {
	return stored?.config.mode === "app" ? "app" : "webhook";
}

// Shell doc 2: switching mode drops every field the new mode's schema does not
// have, and renders the new mode's fields blank unless the STORED row is
// already in that mode -- otherwise a user switching webhook -> app sees `***`
// in botToken and believes a bot token is stored.
export function formValues(
	kind: ChannelKind,
	mode: ChannelMode,
	stored: StoredChannel | null,
): Record<string, string> {
	const carry =
		stored !== null && (!hasModes(kind) || storedMode(stored) === mode)
			? stored.config
			: null;
	const values: Record<string, string> = {};
	for (const field of channelFields(kind, mode)) {
		const value = carry ? carry[field.key] : undefined;
		values[field.key] = typeof value === "string" ? value : "";
	}
	return values;
}

// An empty field is omitted rather than sent as "": the server restores MASKED
// from the stored row and rejects a genuinely missing required field, so an
// empty string would only turn a "you left this blank" into a schema error
// about a malformed value.
export function formConfig(
	kind: ChannelKind,
	mode: ChannelMode,
	values: Record<string, string>,
): Record<string, unknown> {
	const config: Record<string, unknown> = hasModes(kind) ? { mode } : {};
	for (const field of channelFields(kind, mode)) {
		const value = values[field.key] ?? "";
		if (value !== "") config[field.key] = value;
	}
	return config;
}

// Exported so the "this is a public field" invariant is assertable rather than
// promised in a comment.
export const SUMMARY_FIELD: Record<ChannelKind, string> = {
	ntfy: "topic",
	telegram: "chatId",
	discord: "mode",
	slack: "mode",
	email: "address",
};

// Discriminated so the mode discriminant is localized by the caller rather than
// rendered as its raw enum value ("webhook") in the collapsed row.
export type SummaryDetail =
	| { kind: "text"; value: string }
	| { kind: "mode"; value: ChannelMode };

// Public config only. The guard is the same allow-list, not a promise: a future
// SUMMARY_FIELD pointing at a credential renders nothing rather than leaking
// one into the collapsed row.
export function summaryDetail(
	kind: ChannelKind,
	config: Record<string, unknown>,
): SummaryDetail | null {
	const key = SUMMARY_FIELD[kind];
	if (!isPublicChannelField(kind, key)) return null;
	const value = config[key];
	if (typeof value !== "string" || value === "" || value === MASKED) {
		return null;
	}
	if (key !== "mode") return { kind: "text", value };
	return CHANNEL_MODES.includes(value as ChannelMode)
		? { kind: "mode", value: value as ChannelMode }
		: null;
}

export type ChannelHealth =
	| { state: "unconfigured" }
	| { state: "untested" }
	// `ackProven` is the difference between "the provider accepted our request"
	// and "a human pressed the button": a Discord app-mode row whose component
	// was silently dropped has the first and never the second.
	| { state: "verified"; at: number; ackProven: boolean }
	| {
			state: "failing";
			code: ChannelErrorCode;
			at: number;
			verifiedAt: number | null;
	  };

// A stale "Verified" on a dead credential is the state this exists to remove,
// so a delivery failure newer than the last verification wins. The reverse
// ordering does not: a channel that delivered after its last error is working,
// and the worker only clears the error lazily on its next success.
export function channelHealth(
	stored: StoredChannel | null,
	row: ChannelHealthRow | null,
): ChannelHealth {
	if (stored === null) return { state: "unconfigured" };
	const verifiedAt = row?.verifiedAt ?? stored.verifiedAt;
	const ackVerifiedAt = row?.ackVerifiedAt ?? stored.ackVerifiedAt;
	const errorAt = row?.lastErrorAt ?? null;
	const code = row?.lastErrorCode ?? null;
	if (
		errorAt !== null &&
		code !== null &&
		(verifiedAt === null || verifiedAt < errorAt)
	) {
		return { state: "failing", code, at: errorAt, verifiedAt };
	}
	if (verifiedAt !== null) {
		return {
			state: "verified",
			at: verifiedAt,
			ackProven: ackVerifiedAt !== null,
		};
	}
	return { state: "untested" };
}

// Shell doc 6: the email row stays in the list, marked with the reason. Hiding
// it makes a supported feature look absent.
export function rowUnavailable(
	kind: ChannelKind,
	capabilities: ChannelCapabilities,
): "email_smtp_missing" | null {
	if (kind === "email" && !capabilities.email) return "email_smtp_missing";
	return null;
}

// Marked unavailable is not the same as frozen (shell doc 6): a user whose
// operator dropped SMTP must still be able to expand, inspect and REMOVE the
// email channel they already stored.
export function rowFrozen(
	unavailable: string | null,
	stored: StoredChannel | null,
): boolean {
	return unavailable !== null && stored === null;
}

// Courtesy only -- requireInteractiveSupport is the authority and refuses the
// save server-side. Offering a control whose save is guaranteed to fail after
// a filled-in credential form is worse than never offering it.
export function appModeDisabled(capabilities: ChannelCapabilities): boolean {
	return !capabilities.ackBaseUrl;
}

export type ChannelWarning =
	| "app_mode_no_public_url"
	| "email_smtp_missing"
	| "email_delivery_paused"
	| "telegram_webhook_unreachable";

// Degraded, not broken: every one of these keeps the stored config intact and
// names the layer at fault rather than the user's credentials.
export function rowWarnings(
	kind: ChannelKind,
	capabilities: ChannelCapabilities,
	stored: StoredChannel | null,
): ChannelWarning[] {
	const warnings: ChannelWarning[] = [];
	if (
		stored !== null &&
		hasModes(kind) &&
		storedMode(stored) === "app" &&
		!capabilities.ackBaseUrl
	) {
		warnings.push("app_mode_no_public_url");
	}
	// Distinct from the bare unavailable line the row already shows, or a stored
	// row would render the same sentence twice: this one says what happened to
	// the config the user can still see.
	if (stored !== null && kind === "email" && !capabilities.email) {
		warnings.push("email_delivery_paused");
	}
	if (
		kind === "telegram" &&
		capabilities.telegramTransport === "webhook" &&
		!capabilities.telegramWebhookConfigurable
	) {
		warnings.push("telegram_webhook_unreachable");
	}
	return warnings;
}

export function interactionsUrlFor(
	kind: ChannelKind,
	urls: InteractionsUrls | null,
): string | null {
	if (urls === null || !hasModes(kind)) return null;
	return urls[kind] ?? null;
}
