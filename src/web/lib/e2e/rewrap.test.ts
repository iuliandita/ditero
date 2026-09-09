import { afterEach, describe, expect, test, vi } from "vitest";
import { CURRENT_KDF_VERSION } from "../../../domain/e2e/kdf.ts";
import { KeyringError } from "./keyring.ts";
import {
	buildReplacement,
	fetchRecoveryIdentity,
	openPassphraseWrap,
	openRecoveryWrap,
	postRewrap,
	type RecoveryIdentityResponse,
	RewrapError,
} from "./rewrap.ts";

const USER = "user_a";
const OTHER_USER = "user_b";
const PRIVATE_KEY = new Uint8Array(32).map(
	(_, index) => (index * 5 + 1) & 0xff,
);

// Argon2id at m=64 MiB is the real deriver and is deliberately expensive; the
// KEK's correctness is pinned by kdf.ts's own vectors. What matters here is
// that a KEK derived for one purpose cannot open the other purpose's wrap, so
// the fake returns the SAME key for both -- which removes the KDF's domain
// separation and leaves only the AAD binding standing. A fake that varied by
// purpose would make every cross-purpose test pass for the wrong reason.
const derive = async (
	_secret: string,
	_salt: Uint8Array,
	_purpose: string,
	_version: number,
) => new Uint8Array(32).fill(42);

const varyingDerive = async (
	secret: string,
	_salt: Uint8Array,
	_purpose: string,
	_version: number,
) => {
	const key = new Uint8Array(32);
	for (let i = 0; i < secret.length && i < 32; i++) {
		key[i] = secret.charCodeAt(i) & 0xff;
	}
	return key;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubFetch(status: number, body?: unknown) {
	const spy = vi.fn(async () =>
		body === undefined
			? new Response(null, { status })
			: new Response(JSON.stringify(body), { status }),
	);
	vi.stubGlobal("fetch", spy);
	return spy;
}

describe("buildReplacement", () => {
	test("mints a fresh salt per call", async () => {
		const common = {
			userId: USER,
			privateKey: PRIVATE_KEY,
			secret: "same secret",
			purpose: "passphrase" as const,
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive,
		};
		const first = await buildReplacement(common);
		const second = await buildReplacement(common);
		// Reusing the stored salt would let anyone holding both wraps confirm
		// the same secret was used across a change.
		expect(first.salt).not.toBe(second.salt);
		expect(first.wrapped).not.toBe(second.wrapped);
		expect(first.previousWrapped).toBe("old");
	});
});

describe("openPassphraseWrap", () => {
	test("round-trips a replacement it built", async () => {
		const built = await buildReplacement({
			userId: USER,
			privateKey: PRIVATE_KEY,
			secret: "a passphrase",
			purpose: "passphrase",
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive: varyingDerive,
		});
		expect(
			await openPassphraseWrap({
				userId: USER,
				wrapped: built.wrapped,
				salt: built.salt,
				version: CURRENT_KDF_VERSION,
				secret: "a passphrase",
				derive: varyingDerive,
			}),
		).toEqual(PRIVATE_KEY);
	});

	test("a wrong passphrase is wrong-secret, not a crash", async () => {
		const built = await buildReplacement({
			userId: USER,
			privateKey: PRIVATE_KEY,
			secret: "a passphrase",
			purpose: "passphrase",
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive: varyingDerive,
		});
		await expect(
			openPassphraseWrap({
				userId: USER,
				wrapped: built.wrapped,
				salt: built.salt,
				version: CURRENT_KDF_VERSION,
				secret: "not that passphrase",
				derive: varyingDerive,
			}),
		).rejects.toMatchObject({
			name: "KeyringError",
			reason: "wrong-secret",
		});
	});

	// The two wraps hold the same private key and, for a user who reuses the
	// string, could be reached by the same KEK. Only the AAD keeps a recovery
	// wrap from being accepted as a passphrase wrap, so it is asserted with the
	// KDF's domain separation removed.
	test("a recovery wrap does not open as a passphrase wrap", async () => {
		const built = await buildReplacement({
			userId: USER,
			privateKey: PRIVATE_KEY,
			secret: "shared",
			purpose: "recovery",
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive,
		});
		await expect(
			openPassphraseWrap({
				userId: USER,
				wrapped: built.wrapped,
				salt: built.salt,
				version: CURRENT_KDF_VERSION,
				secret: "shared",
				derive,
			}),
		).rejects.toBeInstanceOf(KeyringError);
	});

	test("another user's wrap does not open under this user", async () => {
		const built = await buildReplacement({
			userId: OTHER_USER,
			privateKey: PRIVATE_KEY,
			secret: "shared",
			purpose: "passphrase",
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive,
		});
		await expect(
			openPassphraseWrap({
				userId: USER,
				wrapped: built.wrapped,
				salt: built.salt,
				version: CURRENT_KDF_VERSION,
				secret: "shared",
				derive,
			}),
		).rejects.toBeInstanceOf(KeyringError);
	});
});

describe("openRecoveryWrap", () => {
	async function identityFor(
		secret: string,
	): Promise<RecoveryIdentityResponse> {
		const built = await buildReplacement({
			userId: USER,
			privateKey: PRIVATE_KEY,
			secret,
			purpose: "recovery",
			version: CURRENT_KDF_VERSION,
			previousWrapped: "old",
			derive: varyingDerive,
		});
		return {
			enrolled: true,
			recoveryWrapped: built.wrapped,
			recoverySalt: built.salt,
			formatVersion: CURRENT_KDF_VERSION,
		};
	}

	test("the right code opens the same private key", async () => {
		expect(
			await openRecoveryWrap({
				userId: USER,
				identity: await identityFor("CODE1"),
				code: "CODE1",
				derive: varyingDerive,
			}),
		).toEqual(PRIVATE_KEY);
	});

	test("a wrong code is wrong-secret", async () => {
		await expect(
			openRecoveryWrap({
				userId: USER,
				identity: await identityFor("CODE1"),
				code: "CODE2",
				derive: varyingDerive,
			}),
		).rejects.toMatchObject({ reason: "wrong-secret" });
	});

	// A row missing any part of the input cannot be opened by anything, so it
	// must surface as "no identity" rather than as a wrong code -- which would
	// send the user looking for a code that was never going to work.
	test("an incomplete identity is unenrolled, not a wrong code", async () => {
		await expect(
			openRecoveryWrap({
				userId: USER,
				identity: {
					enrolled: false,
					recoveryWrapped: null,
					recoverySalt: null,
					formatVersion: null,
				},
				code: "CODE1",
				derive: varyingDerive,
			}),
		).rejects.toMatchObject({ reason: "unenrolled" });
	});
});

describe("postRewrap", () => {
	test("resolves on 200", async () => {
		stubFetch(200, { formatVersion: CURRENT_KDF_VERSION });
		await expect(
			postRewrap({ formatVersion: CURRENT_KDF_VERSION }),
		).resolves.toBeUndefined();
	});

	// The caller must tell these apart: a conflict means the wrap moved, so the
	// replacement in hand is addressed to a value that no longer exists and
	// retrying the same body can only lose again.
	test("409 is a conflict and every other failure is not", async () => {
		stubFetch(409);
		await expect(
			postRewrap({ formatVersion: CURRENT_KDF_VERSION }),
		).rejects.toMatchObject({ name: "RewrapError", reason: "conflict" });

		stubFetch(500);
		await expect(
			postRewrap({ formatVersion: CURRENT_KDF_VERSION }),
		).rejects.toMatchObject({ reason: "failed" });
	});

	test("sends credentials, or the session cookie never rides along", async () => {
		const spy = stubFetch(200, {});
		await postRewrap({ formatVersion: CURRENT_KDF_VERSION });
		expect(spy).toHaveBeenCalledWith(
			"/api/e2e/rewrap",
			expect.objectContaining({ credentials: "include", method: "POST" }),
		);
	});
});

describe("fetchRecoveryIdentity", () => {
	test("returns the parsed body", async () => {
		const body = {
			enrolled: true,
			recoveryWrapped: "w",
			recoverySalt: "s",
			formatVersion: CURRENT_KDF_VERSION,
		};
		stubFetch(200, body);
		expect(await fetchRecoveryIdentity()).toEqual(body);
	});

	// 404 is the feature being off. It must throw rather than resolve to a
	// null-shaped identity: a caller that treated it as "not enrolled" would
	// offer to re-enroll a user whose identity is merely unreachable.
	test("throws on a non-ok read", async () => {
		stubFetch(404);
		await expect(fetchRecoveryIdentity()).rejects.toBeInstanceOf(RewrapError);
	});
});
