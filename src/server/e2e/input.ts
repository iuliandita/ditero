import { z } from "zod";

// Wrapped values are opaque to the server. The cap is well above a real
// envelope and low enough that key endpoints cannot be used as bulk storage.
const MAX_BLOB = 64 * 1024;
export const e2eBlobSchema = z.string().min(1).max(MAX_BLOB);

// X25519 public keys are exactly 32 bytes. Validate the decoded value rather
// than accepting any base64url string of a plausible character length.
export const e2ePublicKeySchema = z
	.string()
	.max(64)
	.refine((value) => {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
		try {
			return Buffer.from(value, "base64url").length === 32;
		} catch {
			return false;
		}
	}, "publicKey must be 32 bytes base64url");
