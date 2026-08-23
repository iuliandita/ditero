import { describe, expect, it } from "vitest";
import { KEY_BYTES } from "./envelope.ts";
import {
	CURRENT_WDK_COMMITMENT_VERSION,
	commitWdk,
	isWellFormedCommitment,
	verifyWdkCommitment,
	WDK_COMMITTERS,
	WdkCommitmentError,
} from "./wdk-commitment.ts";

const wdk = () => crypto.getRandomValues(new Uint8Array(KEY_BYTES));

describe("commitWdk", () => {
	// Known-answer vector. The commitment is written once at mint and every
	// later grant is checked against it, so the hashed byte layout -- the
	// prefix, the separators, the WDK's position -- is a one-way door: change
	// it and every stored workspace_key row rejects the key it actually pins.
	// Add a version to WDK_COMMITTERS instead of editing this. Independently
	// reproduced with coreutils:
	//   { printf 'ditero:wdk-commit:v1|ws_1|1'; printf '\x42%.0s' $(seq 32); } | sha256sum
	it("matches the v1 known-answer vector", async () => {
		expect(
			await commitWdk(new Uint8Array(KEY_BYTES).fill(0x42), "ws_1", 1),
		).toBe(
			"1.da3923ed069f10d32a66e23200bc055df54be31e7f21abcadc07c06cafc9bb1f",
		);
	});

	it("is deterministic for the same key and context", async () => {
		const k = wdk();
		expect(await commitWdk(k, "ws_1", 1)).toBe(await commitWdk(k, "ws_1", 1));
	});

	it("differs for a different workspace or version", async () => {
		const k = wdk();
		const a = await commitWdk(k, "ws_1", 1);
		expect(await commitWdk(k, "ws_2", 1)).not.toBe(a);
		expect(await commitWdk(k, "ws_1", 2)).not.toBe(a);
	});

	it("differs for a different key", async () => {
		expect(await commitWdk(wdk(), "ws_1", 1)).not.toBe(
			await commitWdk(wdk(), "ws_1", 1),
		);
	});

	// The commitment is public. A bare hash hides a 256-bit random WDK and
	// nothing else, so the length is what makes the construction sound rather
	// than a caller convention -- and it is also what keeps the hashed layout
	// injective, since the WDK is the only variable-length-looking tail.
	it("refuses a WDK that is not the full key length", async () => {
		for (const bad of [new Uint8Array(16), new Uint8Array(33)]) {
			const committing = commitWdk(bad, "ws_1", 1);
			await expect(committing).rejects.toThrow(
				`wdk-commitment: WDK must be ${KEY_BYTES} bytes`,
			);
			// B4. A bare Error slips past the instanceof + reason shape every
			// caller of this module is told to write, and B3 makes it reachable.
			await expect(committing).rejects.toBeInstanceOf(WdkCommitmentError);
			await expect(committing).rejects.toMatchObject({ reason: "invalid-key" });
		}
	});

	// The precondition belongs to the committer, not the dispatcher:
	// WDK_COMMITTERS is exported, so the injectivity argument has to hold for a
	// direct caller too.
	it("enforces the key length inside the committer itself", async () => {
		const committer = WDK_COMMITTERS[1];
		expect(committer).toBeDefined();
		await expect(
			committer?.commit(new Uint8Array(5), "ws_1", 1),
		).rejects.toMatchObject({ reason: "invalid-key" });
	});

	// Routed through the shared AAD primitives rather than interpolated: a
	// workspace id carrying the separator would let two distinct contexts
	// serialize identically, and a non-integer version emitted "NaN" the last
	// time this directory hand-rolled a binding.
	it("refuses a workspace id containing the separator", async () => {
		await expect(commitWdk(wdk(), "ws|1", 1)).rejects.toThrow(
			'aad: workspaceId must not contain "|"',
		);
	});

	it("refuses an empty workspace id", async () => {
		await expect(commitWdk(wdk(), "", 1)).rejects.toThrow(
			"aad: workspaceId must not be empty",
		);
	});

	it("refuses a key version that is not a positive integer", async () => {
		await expect(commitWdk(wdk(), "ws_1", Number.NaN)).rejects.toThrow(
			"aad: keyVersion must be a positive integer",
		);
		await expect(commitWdk(wdk(), "ws_1", 1.5)).rejects.toThrow(
			"aad: keyVersion must be a positive integer",
		);
		await expect(commitWdk(wdk(), "ws_1", 0)).rejects.toThrow(
			"aad: keyVersion must be a positive integer",
		);
	});

	it("stamps the commitment with the format version that produced it", async () => {
		const commitment = await commitWdk(wdk(), "ws_1", 1);
		expect(commitment.startsWith(`${CURRENT_WDK_COMMITMENT_VERSION}.`)).toBe(
			true,
		);
	});

	it("commits at the explicit current version identically to the default", async () => {
		const k = wdk();
		expect(await commitWdk(k, "ws_1", 1, CURRENT_WDK_COMMITMENT_VERSION)).toBe(
			await commitWdk(k, "ws_1", 1),
		);
	});

	it("refuses to mint at a version with no committer", async () => {
		expect(WDK_COMMITTERS[2]).toBeUndefined();
		await expect(commitWdk(wdk(), "ws_1", 1, 2)).rejects.toThrow(
			"wdk-commitment: unsupported commitment version 2",
		);
	});

	// Passing `.buffer` would hash the whole backing store, so the commitment
	// would pin bytes the recipient can never reconstruct and every grant of a
	// perfectly good key would be refused.
	it("honours byteOffset when the WDK is a view over a larger buffer", async () => {
		const big = crypto.getRandomValues(new Uint8Array(64));
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await commitWdk(view, "ws_1", 1)).toBe(
			await commitWdk(copy, "ws_1", 1),
		);
	});

	it("honours byteOffset when the WDK is a pooled Node Buffer", async () => {
		const pooled = Buffer.from(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
		);
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		const copy = Uint8Array.from(pooled);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await commitWdk(pooled, "ws_1", 1)).toBe(
			await commitWdk(copy, "ws_1", 1),
		);
	});
});

describe("verifyWdkCommitment", () => {
	it("accepts the key it was computed from", async () => {
		const k = wdk();
		const commitment = await commitWdk(k, "ws_1", 1);
		await expect(
			verifyWdkCommitment(k, "ws_1", 1, commitment),
		).resolves.toBeUndefined();
	});

	// The workspace-fork defence. HPKE base mode does not authenticate the
	// sender, so a granter can wrap a DIFFERENT key; both parties then think
	// they hold "the workspace key" and their files are mutually unreadable.
	it("rejects a substituted key", async () => {
		const commitment = await commitWdk(wdk(), "ws_1", 1);
		const verifying = verifyWdkCommitment(wdk(), "ws_1", 1, commitment);
		await expect(verifying).rejects.toBeInstanceOf(WdkCommitmentError);
		await expect(verifying).rejects.toMatchObject({ reason: "mismatch" });
		await expect(verifying).rejects.toThrow("WDK commitment mismatch");
	});

	it("rejects the right key presented for the wrong version", async () => {
		const k = wdk();
		const commitment = await commitWdk(k, "ws_1", 1);
		await expect(
			verifyWdkCommitment(k, "ws_1", 2, commitment),
		).rejects.toMatchObject({ reason: "mismatch" });
	});

	it("rejects the right key presented for the wrong workspace", async () => {
		const k = wdk();
		const commitment = await commitWdk(k, "ws_1", 1);
		await expect(
			verifyWdkCommitment(k, "ws_2", 1, commitment),
		).rejects.toMatchObject({ reason: "mismatch" });
	});

	// Phase order: the stored commitment's format version is a property of the
	// row, not of the key. Reported as a mismatch instead, a client that has the
	// correct key would be told the workspace had forked and would refuse a
	// grant that a format migration -- not a new key -- would have fixed.
	it("rejects a commitment written at a version it cannot recompute", async () => {
		const k = wdk();
		const commitment = await commitWdk(k, "ws_1", 1);
		const future = `2.${commitment.slice(2)}`;
		const verifying = verifyWdkCommitment(k, "ws_1", 1, future);
		await expect(verifying).rejects.toMatchObject({
			reason: "unsupported-version",
		});
		await expect(verifying).rejects.toThrow(
			"wdk-commitment: unsupported commitment version 2",
		);
	});

	// Every one of these is reachable from a stored column and every one of
	// them reported `mismatch` before the digest half was validated -- telling
	// the user a granter had substituted their workspace key, the highest-alarm
	// state the system has, when the actual fault was a truncated restore or a
	// migration that upper-cased a column. `mismatch` must mean one thing.
	it("classifies a corrupt commitment as malformed, never as a fork", async () => {
		const k = wdk();
		const commitment = await commitWdk(k, "ws_1", 1);
		const digest = commitment.slice(2);
		for (const broken of [
			"",
			".",
			"1.",
			`.${digest}`,
			digest,
			`v1.${digest}`,
			`1.2.${digest}`,
			`1.${digest.toUpperCase()}`,
			`01.${digest}`,
			`1.${digest.slice(0, -1)}`,
			`1.${digest}0`,
			`1.0${digest}`,
			"1.zzzz",
		]) {
			const verifying = verifyWdkCommitment(k, "ws_1", 1, broken);
			await expect(verifying).rejects.toBeInstanceOf(WdkCommitmentError);
			await expect(verifying).rejects.toMatchObject({ reason: "malformed" });
		}
	});

	// C1. The version half is still parsed first, so a format this client has
	// never heard of stays distinguishable from a corrupt one.
	it("still reports an unknown format version as unsupported", async () => {
		const k = wdk();
		const digest = (await commitWdk(k, "ws_1", 1)).slice(2);
		for (const future of [`2.${digest}`, `99999999999999999999.${digest}`]) {
			await expect(
				verifyWdkCommitment(k, "ws_1", 1, future),
			).rejects.toMatchObject({ reason: "unsupported-version" });
		}
	});
});

describe("isWellFormedCommitment", () => {
	it("accepts what commitWdk produces", async () => {
		expect(isWellFormedCommitment(await commitWdk(wdk(), "ws_1", 1))).toBe(
			true,
		);
	});

	it("rejects every way the shape can be wrong", () => {
		for (const value of [
			"",
			"not-a-commitment",
			// No separator at position 0, so a bare digest is not a v-less form.
			"a".repeat(64),
			// Unregistered version, checked before the digest because an unknown
			// format has no digest shape to check against.
			"9.".concat("a".repeat(64)),
			// Registered version, digest that is not v1's 64 lowercase hex.
			"1.zz",
			"1.".concat("A".repeat(64)),
			"1.".concat("a".repeat(63)),
			// Leading zero: parses to 1 but is not the canonical printing, and
			// treating it as v1 would report a canonicalisation difference as a
			// substituted key.
			"01.".concat("a".repeat(64)),
			// Second separator lands in the digest, which then fails its pattern.
			"1.1.".concat("a".repeat(62)),
		]) {
			expect(isWellFormedCommitment(value), JSON.stringify(value)).toBe(false);
		}
	});

	it("says nothing about which key the commitment pins", async () => {
		// The whole point of the split: the server stores commitments it can
		// never verify, because it holds no WDK. A recognizer that also passed
		// judgement on the key would be a check the server cannot make.
		const other = await commitWdk(wdk(), "ws_other", 7);
		expect(isWellFormedCommitment(other)).toBe(true);
	});
});
