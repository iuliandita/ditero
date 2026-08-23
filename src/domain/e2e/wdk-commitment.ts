import { aadId, aadKeyVersion, joinAad, KEY_BYTES } from "./envelope.ts";

// The commitment is written once, at mint, into an immutable workspace_key
// column, and every grant of that key version is checked against it forever.
// The hashed layout is therefore a one-way door in the same sense as an
// envelope format: raising the version is ADDITIVE. Add a committer, never
// retire one, or every stored commitment at the retired version stops
// verifying the key it pins and no grant of that version can ever be adopted.
export const CURRENT_WDK_COMMITMENT_VERSION = 1;

// The stored value carries its own version because the schema gives it one
// opaque string column and nothing else. A bare digest would leave verify with
// a constant to compare against, so bumping the algorithm would silently
// reclassify every existing row as a forked workspace.
const VERSION_SEPARATOR = ".";

export type WdkCommitmentFailure =
	| "unsupported-version"
	| "malformed"
	| "invalid-key"
	| "mismatch";

// "the stored commitment is from a newer client" and "this granter handed me a
// different key" demand opposite responses -- migrate versus refuse and alert
// -- and only the second means the workspace forked.
export class WdkCommitmentError extends Error {
	constructor(
		readonly reason: WdkCommitmentFailure,
		message: string,
	) {
		super(message);
		this.name = "WdkCommitmentError";
	}
}

export type WdkCommitter = {
	// The digest half's exact printed shape. Verify must decide "this column is
	// corrupt" before "this granter substituted the key", and the only way to
	// do that without assuming v1's 64 lowercase hex characters forever is for
	// each format to state its own.
	digest: RegExp;
	commit: (
		wdk: Uint8Array,
		workspaceId: string,
		keyVersion: number,
	) => Promise<string>;
};

function hex(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

async function commitV1(
	wdk: Uint8Array,
	workspaceId: string,
	keyVersion: number,
): Promise<string> {
	// Inside the committer, not the dispatcher: WDK_COMMITTERS is exported, so
	// a direct caller must meet the same precondition. Both arguments for it
	// are below.
	if (wdk.length !== KEY_BYTES) {
		throw new WdkCommitmentError(
			"invalid-key",
			`wdk-commitment: WDK must be ${KEY_BYTES} bytes`,
		);
	}
	// A bare hash, not an HMAC or an HKDF: the value is published to the server,
	// so the only thing hiding the WDK is the WDK's own 256 bits of entropy, and
	// keying the hash with the very value it commits to would add nothing. The
	// length check above is what turns that argument from a caller convention
	// into an enforced precondition.
	//
	// It is also what keeps the layout injective. The context is built from the
	// shared AAD primitives, so no field can contain the separator, and the WDK
	// tail is fixed-length, so the boundary between the two is recoverable from
	// the end. Without the length check, a longer workspace id and a shorter key
	// could serialize identically.
	const context = joinAad([
		"ditero:wdk-commit:v1",
		aadId("workspaceId", workspaceId),
		aadKeyVersion(keyVersion),
	]);
	const input = new Uint8Array(context.length + wdk.length);
	input.set(context, 0);
	// `set` honours byteOffset. Hashing `wdk.buffer` instead would pin whatever
	// else shares the backing store, and no recipient could ever reproduce it.
	input.set(wdk, context.length);
	return hex(await crypto.subtle.digest("SHA-256", input));
}

// Every version ever written needs an entry here forever.
export const WDK_COMMITTERS: Record<number, WdkCommitter> = {
	1: { digest: /^[0-9a-f]{64}$/, commit: commitV1 },
};

export async function commitWdk(
	wdk: Uint8Array,
	workspaceId: string,
	keyVersion: number,
	version: number = CURRENT_WDK_COMMITMENT_VERSION,
): Promise<string> {
	const committer = WDK_COMMITTERS[version];
	if (!committer) {
		throw new WdkCommitmentError(
			"unsupported-version",
			`wdk-commitment: unsupported commitment version ${version}`,
		);
	}
	const digest = await committer.commit(wdk, workspaceId, keyVersion);
	return `${version}${VERSION_SEPARATOR}${digest}`;
}

// Total over every string a column can hold. Anything this does not fully
// recognise is `malformed`, so `mismatch` is left meaning one thing only: a
// well-formed commitment of a known format that pins a different key.
function parseCommitment(commitment: string): number {
	const separator = commitment.indexOf(VERSION_SEPARATOR);
	if (separator <= 0) {
		throw new WdkCommitmentError(
			"malformed",
			"wdk-commitment: malformed commitment",
		);
	}
	// No leading zeros: "01." parses to 1 and then fails the whole-string
	// compare, which reported a canonicalisation difference as a substituted
	// key.
	if (!/^[1-9]\d*$/.test(commitment.slice(0, separator))) {
		throw new WdkCommitmentError(
			"malformed",
			"wdk-commitment: malformed commitment",
		);
	}
	const version = Number(commitment.slice(0, separator));
	// Before the digest check, because the digest's shape is a property of the
	// format and an unknown format has no shape to check against.
	const committer = WDK_COMMITTERS[version];
	if (!committer) {
		throw new WdkCommitmentError(
			"unsupported-version",
			`wdk-commitment: unsupported commitment version ${version}`,
		);
	}
	// Everything past the first separator, so a second one ("1.2.3") is a
	// digest that fails its own pattern rather than a version that parses.
	if (!committer.digest.test(commitment.slice(separator + 1))) {
		throw new WdkCommitmentError(
			"malformed",
			"wdk-commitment: malformed commitment",
		);
	}
	return version;
}

/**
 * Shape-only recognizer: the version is registered and the digest matches THAT
 * version's pattern. Says nothing about which key the commitment pins.
 *
 * Exists for the server, which stores commitments it can never verify -- it
 * holds no WDK. The column is immutable and every future grant is checked
 * against it, so a malformed value is only discoverable much later, as every
 * recipient failing to adopt a key that is in fact correct. Reusing the parser
 * rather than restating its shape is what keeps a v2 committer from silently
 * making the server's check wrong.
 */
export function isWellFormedCommitment(commitment: string): boolean {
	try {
		parseCommitment(commitment);
		return true;
	} catch {
		return false;
	}
}

export async function verifyWdkCommitment(
	wdk: Uint8Array,
	workspaceId: string,
	keyVersion: number,
	expected: string,
): Promise<void> {
	// Split by phase. The stored commitment's shape and format version are
	// properties of the row; reported as a mismatch instead, a client holding
	// the correct key is told the workspace forked and refuses a grant that a
	// format migration -- not a new key -- would have fixed.
	const version = parseCommitment(expected);
	// No constant-time compare: both operands are public. The commitment is
	// server-readable by design and the WDK is never compared, only hashed.
	if ((await commitWdk(wdk, workspaceId, keyVersion, version)) !== expected) {
		throw new WdkCommitmentError(
			"mismatch",
			`wdk-commitment: WDK commitment mismatch for ${workspaceId} v${keyVersion}: refusing to adopt the key`,
		);
	}
}
