// Channel/invite presentation helpers over the compiled Paraglide `m`. The
// closed maps keep the raw Postgres codes and field keys out of the DOM; the
// Object.hasOwn guards on the string-keyed maps close a prototype-pollution DoS
// vector flagged in a prior audit.

import type { InviteMailStatus } from "../../domain/invite.ts";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import type { ChannelErrorCode } from "../../domain/notification-retry.ts";
import { m } from "../../paraglide/messages.js";
import type {
	ChannelMode,
	ChannelWarning,
} from "../components/settings/channel-form.ts";

const CHANNEL_LABELS: Record<ChannelKind, () => string> = {
	ntfy: m.channel_label_ntfy,
	telegram: m.channel_label_telegram,
	discord: m.channel_label_discord,
	slack: m.channel_label_slack,
	email: m.channel_label_email,
};

export function channelLabel(kind: ChannelKind): string {
	return CHANNEL_LABELS[kind]();
}

const ERROR_MESSAGES: Record<ChannelErrorCode, () => string> = {
	auth: m.channel_error_auth,
	not_found: m.channel_error_not_found,
	rate_limited: m.channel_error_rate_limited,
	policy: m.channel_error_policy,
	transport: m.channel_error_transport,
};

// The enum is closed by the Postgres type, so this map is total and the raw
// code never reaches the DOM.
export function channelErrorMessage(code: ChannelErrorCode): string {
	return ERROR_MESSAGES[code]();
}

const FIELD_LABELS: Record<string, () => string> = {
	serverUrl: m.channel_field_serverUrl,
	topic: m.channel_field_topic,
	token: m.channel_field_token,
	botToken: m.channel_field_botToken,
	chatId: m.channel_field_chatId,
	webhookUrl: m.channel_field_webhookUrl,
	publicKey: m.channel_field_publicKey,
	signingSecret: m.channel_field_signingSecret,
	channelId: m.channel_field_channelId,
	address: m.channel_field_address,
};

export function channelFieldLabel(key: string): string {
	return Object.hasOwn(FIELD_LABELS, key) ? FIELD_LABELS[key]() : key;
}

const WARNING_MESSAGES: Record<ChannelWarning, () => string> = {
	app_mode_no_public_url: m.channel_mode_app_degraded,
	email_smtp_missing: m.channel_email_unavailable,
	email_delivery_paused: m.channel_email_delivery_paused,
	telegram_webhook_unreachable: m.channel_telegram_webhook_unreachable,
};

export function channelWarningMessage(warning: ChannelWarning): string {
	return WARNING_MESSAGES[warning]();
}

export function channelModeSummary(mode: ChannelMode): string {
	return mode === "app"
		? m.channel_summary_mode_app()
		: m.channel_summary_mode_webhook();
}

// The server answers a rejected channel write with a stable code, never prose:
// its prose named deployment env vars to non-admin users and was untranslatable.
// An unrecognised body falls back rather than being echoed into the DOM.
const SAVE_ERROR_MESSAGES: Record<string, () => string> = {
	unknown_kind: m.channel_save_unknown_kind,
	not_implemented: m.channel_save_not_implemented,
	invalid_config: m.channel_save_invalid_config,
	no_stored_config: m.channel_save_no_stored_config,
	app_mode_unsupported: m.channel_save_app_mode_unsupported,
	email_unsupported: m.channel_save_email_unsupported,
	rate_limited: m.channel_save_rate_limited,
};

export function channelSaveErrorMessage(code: string): string {
	return Object.hasOwn(SAVE_ERROR_MESSAGES, code)
		? SAVE_ERROR_MESSAGES[code]()
		: m.channel_save_failed();
}

// Null where there is nothing to say: a link invite was never going to be
// mailed, and a delivered one needs no warning beyond the confirmation.
export function inviteMailMessage(
	mail: InviteMailStatus,
	email: string,
): { text: string; tone: "info" | "warning" } | null {
	switch (mail.status) {
		case "skipped":
			return null;
		case "sent":
			return { text: m.invite_mail_sent({ email }), tone: "info" };
		case "smtp_disabled":
			return { text: m.invite_mail_smtp_disabled(), tone: "warning" };
		case "no_public_url":
			return { text: m.invite_mail_no_public_url(), tone: "warning" };
		case "invalid_address":
			return { text: m.invite_mail_invalid_address(), tone: "warning" };
		default:
			return {
				text: mail.retryable
					? m.invite_mail_failed_retryable()
					: m.invite_mail_failed_permanent(),
				tone: "warning",
			};
	}
}
