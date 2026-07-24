// Message catalog. Deliberately shaped like Paraglide's compiled output --
// a flat `m` of snake_case keyed functions taking a params object -- so that
// when the locked stack's `@inlang/paraglide-js` is wired up, this and its two
// server-side siblings merge into the single compiled `m` the compiler emits
// per project, and the call sites only change which file they import from.
// No i18n runtime is wired up yet (nothing in the repo has one), so this holds
// the en source strings and is the single place a translator-facing extraction
// reads from.

import type { InviteMailStatus } from "../../domain/invite.ts";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import type { ChannelErrorCode } from "../../domain/notification-retry.ts";
import type {
	ChannelMode,
	ChannelWarning,
} from "../components/settings/channel-form.ts";

export const m = {
	notifications_heading: () => "Notifications",
	notifications_channels_heading: () => "Channels",
	notifications_defaults_heading: () => "Defaults",
	notifications_no_channels: () =>
		"No channel configured yet - reminders will not be delivered outside the app.",

	channel_label_ntfy: () => "ntfy",
	channel_label_telegram: () => "Telegram",
	channel_label_discord: () => "Discord",
	channel_label_slack: () => "Slack",
	channel_label_email: () => "Email",

	channel_summary_unconfigured: () => "Not set up",
	channel_summary_mode_webhook: () => "Webhook mode",
	channel_summary_mode_app: () => "App mode",
	channel_toggle_label: (p: { channel: string }) =>
		`${p.channel} channel enabled`,
	channel_toggle_on: () => "On",
	channel_toggle_off: () => "Off",

	channel_mode_legend: () => "Delivery mode",
	channel_mode_webhook: () => "Webhook",
	channel_mode_app: () => "App",
	channel_mode_webhook_note: (p: { channel: string }) =>
		`${p.channel} webhooks can't carry buttons, so reminders include a link that opens Ditero to acknowledge. Switch to App mode for an Acknowledge button inside the chat.`,
	channel_mode_app_note: (p: { channel: string }) =>
		`Connect a bot. Adds an Acknowledge button inside ${p.channel}.`,
	channel_mode_app_unavailable: () =>
		"Needs a public web address for this server. Ask your administrator to set one.",
	channel_mode_app_degraded: () =>
		"In-chat buttons are off: this server has no public address. Reminders are still delivered with a link.",
	channel_app_setup_hint: () =>
		"Invite the bot to your server or workspace, then paste this URL into the app's interactivity settings.",
	channel_interactions_url_label: () => "Interactions URL",
	channel_copy: () => "Copy",
	channel_copied: () => "Copied",

	channel_email_unavailable: () =>
		"Email delivery is not set up on this server.",
	channel_email_delivery_paused: () =>
		"Email delivery is not set up on this server, so nothing is being sent. Your settings are kept.",
	channel_telegram_webhook_unreachable: () =>
		"Telegram is set up for webhooks, but this server has no public address. Ask your administrator.",

	channel_field_serverUrl: () => "Server URL",
	channel_field_topic: () => "Topic",
	channel_field_token: () => "Access token (optional)",
	channel_field_botToken: () => "Bot token",
	channel_field_chatId: () => "Chat ID",
	channel_field_webhookUrl: () => "Webhook URL",
	channel_field_publicKey: () => "Public key",
	channel_field_signingSecret: () => "Signing secret",
	channel_field_channelId: () => "Channel ID",
	channel_field_address: () => "Email address",

	channel_action_setup: () => "Set up",
	channel_action_save: () => "Save",
	channel_action_test: () => "Save & test send",
	channel_action_remove: () => "Remove",

	channel_status_untested: () => "Not tested",
	// Two claims, never merged: "Verified" means an acknowledgement came back
	// through this channel, "Sent" means only that the provider accepted it.
	channel_status_verified: (p: { when: string }) => `Verified ${p.when}`,
	channel_status_sent_unacked: (p: { when: string }) =>
		`Sent ${p.when} - not acknowledged`,
	channel_status_test_sent: () => "Sent - waiting for the acknowledgement",
	channel_status_test_acked: () => "Acknowledged",
	channel_copied_announcement: () => "Copied",
	channel_status_rejected: () =>
		"Last delivery was rejected. Check the credentials.",

	channel_error_auth: () => "The credentials were rejected",
	channel_error_not_found: () => "The destination no longer exists",
	channel_error_rate_limited: () => "The provider is rate limiting us",
	channel_error_policy: () => "Blocked by this server's network policy",
	channel_error_transport: () => "Could not reach the provider",

	channel_save_unknown_kind: () => "That channel is not supported.",
	channel_save_not_implemented: () => "That channel is not available yet.",
	channel_save_invalid_config: () =>
		"Some of those settings are not valid. Check the fields and try again.",
	channel_save_no_stored_config: () => "There is nothing saved to update yet.",
	channel_save_app_mode_unsupported: () =>
		"App mode needs a public web address for this server. Ask your administrator to set one.",
	channel_save_email_unsupported: () =>
		"Email delivery is not set up on this server.",
	channel_save_rate_limited: () =>
		"Too many test sends. Wait a minute and try again.",
	channel_save_failed: () => "That could not be saved. Try again.",
	channel_remove_failed: () => "That could not be removed. Try again.",
	channel_load_failed: () => "Channels could not be loaded.",

	invite_mail_sent: (p: { email: string }) =>
		`Invitation emailed to ${p.email}.`,
	invite_mail_smtp_disabled: () =>
		"Email is not set up on this server, so nothing was sent - share the link yourself.",
	invite_mail_no_public_url: () =>
		"This server has no public web address, so no email was sent - share the link yourself.",
	invite_mail_invalid_address: () =>
		"That address could not be emailed - share the link yourself.",
	invite_mail_failed_retryable: () =>
		"The invitation could not be emailed just now. The link below still works - share it yourself.",
	invite_mail_failed_permanent: () =>
		"The invitation could not be emailed and will not arrive. Share the link below yourself.",
} as const;

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
