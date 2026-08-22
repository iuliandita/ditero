/// <reference lib="webworker" />
import { deriveKek, KdfError } from "../../../domain/e2e/kdf.ts";
import type { KdfRequest, KdfResponse } from "./kdf-protocol.ts";

// A module worker, so the CSP's `script-src 'self'` still covers it: a blob or
// data worker would need a directive this app deliberately does not carry.
// Argon2id at m=64 MiB blocks its thread for hundreds of milliseconds, and on
// the main thread that is a frozen dialog during the one interaction the user
// is least willing to see stutter.
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (event: MessageEvent<KdfRequest>) => {
	const { id, secret, salt, purpose, version } = event.data;
	deriveKek(secret, salt, purpose, version).then(
		(kek) => scope.postMessage({ id, kek } satisfies KdfResponse),
		(error: unknown) =>
			scope.postMessage({
				id,
				// Structured clone erases the subclass, so the discriminant is
				// copied onto the message. Without it every failure arrives as
				// "unknown" and the UI cannot tell a malformed salt from a record
				// this client is too old to open.
				failure: error instanceof KdfError ? error.reason : "unknown",
				message: error instanceof Error ? error.message : String(error),
			} satisfies KdfResponse),
	);
});
