// Acceptance of the vendor-service dictation notice, kept per user in
// localStorage on this device (same pattern as hints.ts). Unreadable or
// unwritable storage falls back to the current page session.

type KeyValue = Pick<Storage, "getItem" | "setItem">;

export const voiceConsentKey = (userId: string): string =>
	`ditero.voice-vendor-notice.${userId}`;

const session = new Set<string>();

export function readVoiceConsent(
	userId: string,
	storage: KeyValue | null,
): boolean {
	if (userId === "") return false;
	if (session.has(userId)) return true;
	try {
		return storage?.getItem(voiceConsentKey(userId)) === "1";
	} catch {
		return false;
	}
}

export function writeVoiceConsent(
	userId: string,
	storage: KeyValue | null,
): void {
	if (userId === "") return;
	session.add(userId);
	try {
		storage?.setItem(voiceConsentKey(userId), "1");
	} catch {
		// Non-fatal: the acceptance still holds for this page session.
	}
}

export function resetVoiceConsentSession(): void {
	session.clear();
}
