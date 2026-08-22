import type { KdfFailure, KekPurpose } from "../../../domain/e2e/kdf.ts";

// The wire between the page and the Argon2id worker. Structured clone carries
// Uint8Array and plain objects, so nothing here needs framing -- but an Error
// crosses as a bare {} with its subclass and `reason` erased, which is the one
// thing the unlock UI must not lose.
export type KdfRequest = {
	id: number;
	secret: string;
	salt: Uint8Array;
	purpose: KekPurpose;
	version: number;
};

export type KdfSuccess = { id: number; kek: Uint8Array };

export type KdfFailureMessage = {
	id: number;
	failure: KdfFailure | "unknown";
	message: string;
};

export type KdfResponse = KdfSuccess | KdfFailureMessage;

export function isKdfFailure(
	response: KdfResponse,
): response is KdfFailureMessage {
	return "failure" in response;
}
