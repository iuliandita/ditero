// At-rest encryption for notification_channel.config (design 1). The column is
// JSONB holding channel credentials -- ntfy tokens today, bot tokens and
// webhook URLs in M3b -- so a DB backup or a replica read would otherwise hand
// over every user's notification credentials in plaintext.
//
// Only the secret half is enveloped: the public fields (ntfy serverUrl/topic)
// stay readable so operators can inspect a config, and "secret" is defined by
// the same allow-list the mask uses (isPublicChannelField), never a second list.
import type { ChannelKind } from "../domain/notification-channel.ts";
import { isPublicChannelField } from "../domain/notification-channel.ts";
import type { FieldKeyRing } from "./field-encryption.ts";
import {
	createFieldKeyRing,
	decryptField,
	encryptField,
} from "./field-encryption.ts";

const ENVELOPE_PREFIX = "ditero:v1:";

export function channelFieldContext(kind: ChannelKind, field: string): string {
	return `notification-channel:${kind}:${field}`;
}

// Mirrors auth.ts: production cannot boot without the key (auth.ts throws), so
// the null branch is a dev/test-without-a-key convenience only.
export function channelKeyRing(
	env: NodeJS.ProcessEnv = process.env,
): FieldKeyRing | null {
	const current = env.DITERO_ENCRYPTION_KEY;
	if (!current) return null;
	return createFieldKeyRing({ current, next: env.DITERO_ENCRYPTION_KEY_NEXT });
}

export function encryptChannelConfig(
	kind: ChannelKind,
	config: Record<string, unknown>,
	ring: FieldKeyRing | null,
): Record<string, unknown> {
	if (!ring) return { ...config };
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		out[key] =
			isPublicChannelField(kind, key) ||
			typeof value !== "string" ||
			value.startsWith(ENVELOPE_PREFIX)
				? value
				: encryptField(value, channelFieldContext(kind, key), ring);
	}
	return out;
}

// Tolerates a plaintext secret so rows written before this landed keep working
// until `security:encrypt-channel-configs` has run over them. A value that
// LOOKS enveloped but fails to decrypt throws -- a wrong key must fail loud,
// not silently ship a ciphertext string to a provider as a bearer token.
export function decryptChannelConfig(
	kind: ChannelKind,
	config: Record<string, unknown>,
	ring: FieldKeyRing | null,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (
			isPublicChannelField(kind, key) ||
			typeof value !== "string" ||
			!value.startsWith(ENVELOPE_PREFIX)
		) {
			out[key] = value;
			continue;
		}
		if (!ring) {
			throw new Error(
				"notification channel config is encrypted but no encryption key is configured",
			);
		}
		out[key] = decryptField(
			value,
			channelFieldContext(kind, key),
			ring,
		).plaintext;
	}
	return out;
}

export function isEncryptedChannelValue(value: unknown): boolean {
	return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}
