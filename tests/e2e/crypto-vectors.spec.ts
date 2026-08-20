// Design §13: the crypto layer's vectors all run under Bun, which is not the
// runtime that holds a user's keys. This re-runs them in Chromium, Firefox and
// WebKit -- the three engines behind the web app, the Capacitor WebView and the
// Tauri WebView -- through the dev-only handle installed by
// src/web/dev/crypto-vectors.ts.
//
// Deliberately NOT a port of src/domain/e2e/*.test.ts: those suites use Node's
// Buffer (the pooled-Buffer byteOffset fixtures exist to catch a Node-specific
// hazard) and cannot run in a page at all.
//
// Every expectation is a value computed outside the page: a published RFC
// vector, a known-answer hex pinned by the Bun suites, or an input generated
// here and handed in. "It did not throw" is not an assertion.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

type Rfc9180Vector = {
	kem_id: number;
	kdf_id: number;
	aead_id: number;
	info: string;
	pkEm: string;
	skRm: string;
	encryptions: { aad: string; pt: string; ct: string }[];
};

// The same file hpke.test.ts reads, so the two proofs cannot drift apart.
const vector = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("../../src/domain/e2e/vectors/rfc9180-a2.json", import.meta.url),
		),
		"utf8",
	),
) as Rfc9180Vector;

// Pinned by src/domain/e2e/kdf.test.ts. Argon2id v1 over a 0x42 salt: pins the
// parameters as applied, the domain-separation string and the encoding at once.
const KDF_KAT =
	"a1f79fffcf2d70818fca22c5ff22d35e1bc1124e7a6e4630c0f6643ae9f2ef27";

// Pinned by src/domain/e2e/wdk-commitment.test.ts, for a 0x42-filled WDK.
const COMMITMENT_KAT =
	"1.da3923ed069f10d32a66e23200bc055df54be31e7f21abcadc07c06cafc9bb1f";

// A canonical recovery code and the recovery-domain KEK it derives over a 0x37
// salt, both computed under Bun through the same modules. Pins that the browser
// reaches the identical key from the identical printed code -- the one value a
// user re-enters months later with nothing to fall back on.
const RECOVERY_CANONICAL = "0123456789ABCDEFGHJKMNPQRSTVWX2E4M4";
const RECOVERY_KEK =
	"00a5548af115d5ef3eb83b07e8b1ba4b95999582c8f57d0886e02e194dcc6d08";

const hex = (bytes: Uint8Array | Buffer) =>
	Buffer.from(bytes).toString("hex").toLowerCase();

// Each Argon2id derivation is memory-hard by design and the first in a page
// also pays WASM instantiation; three engines, and WebKit is the slowest.
const ARGON2_TIMEOUT = 180_000;

const SEGMENT_BYTES = 1024 * 1024;
// Past two segments on purpose, plus a remainder, so the full-segment loop, the
// final-flag path and a partial tail all run.
const STREAM_BYTES = 3 * SEGMENT_BYTES + 7;

// Byte i of the stream payload. Generated on both sides from the same rule
// rather than shipped over CDP: 3 MB through the protocol would dominate the
// test, and a rule is what makes the page's digest checkable against a digest
// computed here.
const patternByte = (i: number) => (i * 31 + 7) & 0xff;

function streamPayloadDigest(): string {
	const payload = Buffer.allocUnsafe(STREAM_BYTES);
	for (let i = 0; i < STREAM_BYTES; i++) payload[i] = patternByte(i);
	return createHash("sha256").update(payload).digest("hex");
}

// The harness is installed from the entry module, so the login page is enough:
// no session, no seeded data, nothing but the bundle.
async function openHarness(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForFunction(() => Boolean(window.__diteroCrypto));
}

test.beforeEach(async ({ page }) => {
	await openHarness(page);
});

test("hpke: the RFC 9180 A.2 vector decrypts and a WDK round-trips", async ({
	page,
}) => {
	const wdk = hex(randomBytes(32));
	const result = await page.evaluate(
		async ({ v, wdkHex }) => {
			const harness = window.__diteroCrypto;
			if (!harness) throw new Error("crypto harness missing");
			const { hpke } = harness;
			const unhex = (s: string) =>
				Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
			const toHex = (b: Uint8Array) =>
				Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
			const reasonOf = async (run: () => Promise<unknown>) => {
				try {
					await run();
					return "no-error";
				} catch (error) {
					return (error as { reason?: string }).reason ?? String(error);
				}
			};

			const suite = hpke.hpkeSuiteForTests();
			const recipient = await suite.createRecipientContext({
				recipientKey: await suite.kem.deserializePrivateKey(unhex(v.skRm)),
				enc: unhex(v.pkEm),
				info: unhex(v.info),
			});
			const published = await recipient.open(unhex(v.ct), unhex(v.aad));

			const info = {
				workspaceId: "ws_1",
				keyVersion: 1,
				recipientUserId: "u_1",
				recipientFingerprint: "fp_1",
			};
			const pair = await suite.kem.generateKeyPair();
			const stranger = await suite.kem.generateKeyPair();
			const wdk = unhex(wdkHex);
			const sealed = await hpke.sealWdk(wdk, pair.publicKey, info);

			return {
				suiteIds: [suite.kem.id, suite.kdf.id, suite.aead.id],
				published: toHex(new Uint8Array(published)),
				opened: toHex(await hpke.openWdk(sealed, pair.privateKey, info)),
				binding: new TextDecoder().decode(hpke.wdkInfo(info)),
				wrongHolder: await reasonOf(() =>
					hpke.openWdk(sealed, stranger.privateKey, info),
				),
				wrongWorkspace: await reasonOf(() =>
					hpke.openWdk(sealed, pair.privateKey, {
						...info,
						workspaceId: "ws_2",
					}),
				),
				malformedEnc: await reasonOf(() =>
					hpke.openWdk(
						{ ...sealed, enc: sealed.enc.slice(0, 16) },
						pair.privateKey,
						info,
					),
				),
			};
		},
		{
			v: {
				skRm: vector.skRm,
				pkEm: vector.pkEm,
				info: vector.info,
				ct: vector.encryptions[0]?.ct ?? "",
				aad: vector.encryptions[0]?.aad ?? "",
			},
			wdkHex: wdk,
		},
	);

	expect(result.suiteIds).toEqual([
		vector.kem_id,
		vector.kdf_id,
		vector.aead_id,
	]);
	expect(result.published).toBe(vector.encryptions[0]?.pt);
	expect(result.opened).toBe(wdk);
	expect(result.binding).toBe("ditero:wdk:v1|ws_1|1|u_1|fp_1");
	expect(result.wrongHolder).toBe("cannot-open");
	expect(result.wrongWorkspace).toBe("cannot-open");
	expect(result.malformedEnc).toBe("malformed");
});

test("kdf: the v1 known-answer vector reproduces", async ({ page }) => {
	test.setTimeout(ARGON2_TIMEOUT);
	const result = await page.evaluate(async () => {
		const harness = window.__diteroCrypto;
		if (!harness) throw new Error("crypto harness missing");
		const { kdf } = harness;
		const toHex = (b: Uint8Array) =>
			Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		const salt = new Uint8Array(16).fill(0x42);
		const kat = await kdf.deriveKek("correct horse", salt, "passphrase");
		const recovery = await kdf.deriveKek("correct horse", salt, "recovery");
		return {
			kat: toHex(kat),
			length: kat.length,
			recovery: toHex(recovery),
			params: kdf.KDF_PARAMS[1],
		};
	});

	expect(result.kat).toBe(KDF_KAT);
	expect(result.length).toBe(32);
	// Same secret, same salt: only the purpose separates them, and the two wraps
	// of a private key rest on that.
	expect(result.recovery).not.toBe(result.kat);
	expect(result.params).toEqual({
		memorySizeKiB: 65536,
		iterations: 3,
		parallelism: 1,
		hashLength: 32,
	});
});

test("envelope: a wrap round-trips and a mismatched AAD is refused", async ({
	page,
}) => {
	const key = hex(randomBytes(32));
	const plaintext = hex(randomBytes(64));
	const result = await page.evaluate(
		async ({ keyHex, plaintextHex }) => {
			const harness = window.__diteroCrypto;
			if (!harness) throw new Error("crypto harness missing");
			const { envelope } = harness;
			const unhex = (s: string) =>
				Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
			const toHex = (b: Uint8Array) =>
				Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
			const reasonOf = async (run: () => Promise<unknown>) => {
				try {
					await run();
					return "no-error";
				} catch (error) {
					return (error as { reason?: string }).reason ?? String(error);
				}
			};

			const key = unhex(keyHex);
			const plaintext = unhex(plaintextHex);
			const aad = envelope.aad.dek("ws_1", 1, "att_1");
			const wrapped = await envelope.encryptWrapped(plaintext, key, aad);

			return {
				version: wrapped.version,
				nonceLength: wrapped.nonce.length,
				ciphertextLength: wrapped.ciphertext.length,
				opened: toHex(await envelope.decryptWrapped(wrapped, key, aad)),
				otherAttachment: await reasonOf(() =>
					envelope.decryptWrapped(
						wrapped,
						key,
						envelope.aad.dek("ws_1", 1, "att_2"),
					),
				),
				otherKeyVersion: await reasonOf(() =>
					envelope.decryptWrapped(
						wrapped,
						key,
						envelope.aad.dek("ws_1", 2, "att_1"),
					),
				),
				wrongKey: await reasonOf(() =>
					envelope.decryptWrapped(
						wrapped,
						crypto.getRandomValues(new Uint8Array(32)),
						aad,
					),
				),
				shortNonce: await reasonOf(() =>
					envelope.decryptWrapped(
						{ ...wrapped, nonce: wrapped.nonce.slice(0, 8) },
						key,
						aad,
					),
				),
			};
		},
		{ keyHex: key, plaintextHex: plaintext },
	);

	expect(result.opened).toBe(plaintext);
	expect(result.version).toBe(1);
	expect(result.nonceLength).toBe(12);
	// 64 bytes of plaintext plus a full 16-byte GCM tag.
	expect(result.ciphertextLength).toBe(80);
	expect(result.otherAttachment).toBe("cannot-open");
	expect(result.otherKeyVersion).toBe("cannot-open");
	expect(result.wrongKey).toBe("cannot-open");
	// A broken record must never read as a key failure.
	expect(result.shortNonce).toBe("malformed");
});

test("stream: a multi-segment payload round-trips and a cut stream is refused", async ({
	page,
}) => {
	const dek = hex(randomBytes(32));
	const result = await page.evaluate(
		async ({ dekHex, size, seed }) => {
			const harness = window.__diteroCrypto;
			if (!harness) throw new Error("crypto harness missing");
			const { stream } = harness;
			const unhex = (s: string) =>
				Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
			const toHex = (b: Uint8Array) =>
				Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
			const reasonOf = async (run: () => Promise<unknown>) => {
				try {
					await run();
					return "no-error";
				} catch (error) {
					return (error as { reason?: string }).reason ?? String(error);
				}
			};

			const dek = unhex(dekHex);
			const payload = new Uint8Array(size);
			for (let i = 0; i < size; i++) payload[i] = (i * seed.a + seed.b) & 0xff;

			const sealed: Uint8Array[] = [];
			for await (const chunk of stream.encryptStream(
				(async function* () {
					yield payload;
				})(),
				dek,
				"content",
			)) {
				sealed.push(chunk);
			}

			const drain = async (
				chunks: Uint8Array[],
				key: Uint8Array = dek,
				purpose: "content" | "thumbnail" = "content",
			) => {
				const out: Uint8Array[] = [];
				let total = 0;
				for await (const chunk of stream.decryptStream(
					(async function* () {
						for (const c of chunks) yield c;
					})(),
					key,
					purpose,
				)) {
					out.push(chunk);
					total += chunk.length;
				}
				const joined = new Uint8Array(total);
				let at = 0;
				for (const chunk of out) {
					joined.set(chunk, at);
					at += chunk.length;
				}
				return joined;
			};

			const plain = await drain(sealed);
			const digest = new Uint8Array(
				await crypto.subtle.digest("SHA-256", plain),
			);

			// A download cut short: the final segment never arrives.
			const cut = sealed.slice(0, -1);
			// A tampered middle segment, which must NOT read as truncation.
			const tampered = sealed.map((chunk) => Uint8Array.from(chunk));
			const middle = tampered[1];
			if (middle) middle[0] ^= 0xff;
			// Not this blob's key.
			const otherDek = crypto.getRandomValues(new Uint8Array(32));

			return {
				digest: toHex(digest),
				plainLength: plain.length,
				chunkLengths: sealed.map((chunk) => chunk.length),
				truncated: await reasonOf(() => drain(cut)),
				tampered: await reasonOf(() => drain(tampered)),
				wrongPurpose: await reasonOf(() => drain(sealed, dek, "thumbnail")),
				wrongKey: await reasonOf(() => drain(sealed, otherDek, "content")),
			};
		},
		{ dekHex: dek, size: STREAM_BYTES, seed: { a: 31, b: 7 } },
	);

	expect(result.plainLength).toBe(STREAM_BYTES);
	expect(result.digest).toBe(streamPayloadDigest());
	// Header, three sealed full segments, then the 7-byte tail with its own tag.
	expect(result.chunkLengths).toEqual([
		33,
		SEGMENT_BYTES + 16,
		SEGMENT_BYTES + 16,
		SEGMENT_BYTES + 16,
		7 + 16,
	]);
	expect(result.truncated).toBe("truncated");
	expect(result.tampered).toBe("cannot-open");
	expect(result.wrongPurpose).toBe("cannot-open");
	expect(result.wrongKey).toBe("cannot-open");
});

test("wdk-commitment: the KAT reproduces and a substituted key is a mismatch", async ({
	page,
}) => {
	const result = await page.evaluate(async () => {
		const harness = window.__diteroCrypto;
		if (!harness) throw new Error("crypto harness missing");
		const { wdkCommitment } = harness;
		const reasonOf = async (run: () => Promise<unknown>) => {
			try {
				await run();
				return "no-error";
			} catch (error) {
				return (error as { reason?: string }).reason ?? String(error);
			}
		};
		const wdk = new Uint8Array(32).fill(0x42);
		const substituted = new Uint8Array(32).fill(0x43);
		const commitment = await wdkCommitment.commitWdk(wdk, "ws_1", 1);
		return {
			commitment,
			verified: await reasonOf(() =>
				wdkCommitment.verifyWdkCommitment(wdk, "ws_1", 1, commitment),
			),
			substituted: await reasonOf(() =>
				wdkCommitment.verifyWdkCommitment(substituted, "ws_1", 1, commitment),
			),
			otherWorkspace: await reasonOf(() =>
				wdkCommitment.verifyWdkCommitment(wdk, "ws_2", 1, commitment),
			),
			// Must NOT read as a key substitution: nothing forked, the row is junk.
			garbage: await reasonOf(() =>
				wdkCommitment.verifyWdkCommitment(wdk, "ws_1", 1, "not-a-commitment"),
			),
			futureVersion: await reasonOf(() =>
				wdkCommitment.verifyWdkCommitment(
					wdk,
					"ws_1",
					1,
					`9.${"ab".repeat(32)}`,
				),
			),
		};
	});

	expect(result.commitment).toBe(COMMITMENT_KAT);
	expect(result.verified).toBe("no-error");
	expect(result.substituted).toBe("mismatch");
	expect(result.otherWorkspace).toBe("mismatch");
	expect(result.garbage).toBe("malformed");
	expect(result.futureVersion).toBe("unsupported-version");
});

test("recovery-code: the canonical form derives the KEK pinned under Bun", async ({
	page,
}) => {
	test.setTimeout(ARGON2_TIMEOUT);
	const result = await page.evaluate(async (canonical) => {
		const harness = window.__diteroCrypto;
		if (!harness) throw new Error("crypto harness missing");
		const { kdf, recoveryCode } = harness;
		const toHex = (b: Uint8Array) =>
			Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		const reasonOf = async (run: () => Promise<unknown>) => {
			try {
				await run();
				return "no-error";
			} catch (error) {
				return (error as { reason?: string }).reason ?? String(error);
			}
		};

		const generated = await recoveryCode.generateRecoveryCode();
		const normalisedOwn = await recoveryCode.normaliseRecoveryCode(
			generated.display,
		);
		// The pinned code, retyped the way a user reads it off paper: grouped,
		// lower case, with a stray space and the look-alikes O/I for 0/1.
		const retyped = recoveryCode
			.formatRecoveryCode(await recoveryCode.normaliseRecoveryCode(canonical))
			.toLowerCase()
			.replace("0", "O")
			.replace("1", "I")
			.replace("-", " - ");
		const fromRetyped = await recoveryCode.normaliseRecoveryCode(retyped);

		return {
			display: generated.display,
			canonicalLength: generated.canonical.length,
			normalisedOwn,
			roundTripped: normalisedOwn === generated.canonical,
			fromRetyped,
			kek: toHex(
				await kdf.deriveRecoveryKek(fromRetyped, new Uint8Array(16).fill(0x37)),
			),
			// The display form derives a different, permanently unopenable KEK, so
			// the checksum path must reject anything that is not canonical.
			badChecksum: await reasonOf(() =>
				recoveryCode.normaliseRecoveryCode(
					`${canonical.slice(0, -1)}${canonical.endsWith("4") ? "5" : "4"}`,
				),
			),
			wrongLength: await reasonOf(() =>
				recoveryCode.normaliseRecoveryCode(canonical.slice(0, -1)),
			),
			badCharacter: await reasonOf(() =>
				recoveryCode.normaliseRecoveryCode(`${canonical.slice(0, -1)}U`),
			),
		};
	}, RECOVERY_CANONICAL);

	expect(result.canonicalLength).toBe(35);
	expect(result.display).toMatch(
		/^([0-9A-HJKMNP-TV-Z]{5}-){6}[0-9A-HJKMNP-TV-Z]{5}$/,
	);
	expect(result.roundTripped).toBe(true);
	// The transcription pass must land back on the exact string the KEK is
	// derived from, not merely on something well formed.
	expect(result.fromRetyped).toBe(RECOVERY_CANONICAL);
	expect(result.kek).toBe(RECOVERY_KEK);
	expect(result.badChecksum).toBe("checksum");
	expect(result.wrongLength).toBe("length");
	expect(result.badCharacter).toBe("malformed");
});
