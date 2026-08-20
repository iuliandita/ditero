import { describe, expect, it } from "vitest";
import {
	exportPublicKey,
	hpkeSuiteForTests,
	importRecipientPublicKey,
	openWdk,
	sealWdk,
	type WdkInfo,
	WdkOpenError,
	wdkInfo,
} from "./hpke.ts";
import vector from "./vectors/rfc9180-a2.json" with { type: "json" };

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const INFO: WdkInfo = {
	workspaceId: "ws_1",
	keyVersion: 1,
	recipientUserId: "u_1",
	recipientFingerprint: "fp_1",
};

const suite = hpkeSuiteForTests();

async function fixture(
	wdk: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
) {
	const kp = await suite.kem.generateKeyPair();
	return { kp, wdk, sealed: await sealWdk(wdk, kp.publicKey, INFO) };
}

async function openFailure(fn: () => Promise<unknown>): Promise<WdkOpenError> {
	const caught = await fn().then(
		() => null,
		(e: unknown) => e,
	);
	expect(caught).toBeInstanceOf(WdkOpenError);
	return caught as WdkOpenError;
}

describe("hpke suite", () => {
	it("matches the RFC 9180 A.2 vector identity", () => {
		expect(suite.kem.id).toBe(vector.kem_id);
		expect(suite.kdf.id).toBe(vector.kdf_id);
		expect(suite.aead.id).toBe(vector.aead_id);
	});

	it("decrypts the published ciphertext with the published receiver key", async () => {
		const rk = await suite.kem.deserializePrivateKey(hex(vector.skRm));
		const recipient = await suite.createRecipientContext({
			recipientKey: rk,
			enc: hex(vector.pkEm),
			info: hex(vector.info),
		});
		const pt = await recipient.open(
			hex(vector.encryptions[0].ct),
			hex(vector.encryptions[0].aad),
		);
		expect(Buffer.from(pt).toString("hex")).toBe(vector.encryptions[0].pt);
	});
});

describe("key bytes", () => {
	it("round-trips a public key through its serialized form", async () => {
		const kp = await suite.kem.generateKeyPair();
		const bytes = await exportPublicKey(kp.publicKey);
		expect(bytes).toHaveLength(32);

		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const sealed = await sealWdk(
			wdk,
			await importRecipientPublicKey(bytes),
			INFO,
		);
		expect(await openWdk(sealed, kp.privateKey, INFO)).toEqual(wdk);
	});

	it("rejects a public key of the wrong length", async () => {
		await expect(importRecipientPublicKey(new Uint8Array(16))).rejects.toThrow(
			/^hpke: malformed public key$/,
		);
	});
});

describe("wdkInfo", () => {
	it("binds workspace, version, recipient and fingerprint", () => {
		const info = new TextDecoder().decode(wdkInfo({ ...INFO, keyVersion: 2 }));
		expect(info).toBe("ditero:wdk:v1|ws_1|2|u_1|fp_1");
	});

	it("differs when any single component differs", () => {
		const variants = [
			{ ...INFO, workspaceId: "ws_2" },
			{ ...INFO, keyVersion: 2 },
			{ ...INFO, recipientUserId: "u_2" },
			{ ...INFO, recipientFingerprint: "fp_2" },
		];
		const seen = new Set(
			variants.map((v) => new TextDecoder().decode(wdkInfo(v))),
		);
		expect(seen.size).toBe(4);
		expect(seen.has(new TextDecoder().decode(wdkInfo(INFO)))).toBe(false);
	});

	it.each([
		"workspaceId",
		"recipientUserId",
		"recipientFingerprint",
	] as const)("rejects a separator inside %s", (field) => {
		expect(() => wdkInfo({ ...INFO, [field]: "a|b" })).toThrow(
			new RegExp(`^hpke: ${field} must not contain`),
		);
	});

	it("would otherwise let two distinct contexts collide", () => {
		// The pair this escaping exists to keep apart.
		expect(() => wdkInfo({ ...INFO, recipientUserId: "1|u_1" })).toThrow();
		expect(() => wdkInfo({ ...INFO, workspaceId: "ws_1|1" })).toThrow();
	});
});

describe("sealWdk / openWdk", () => {
	it("round-trips a WDK to the holder of the private key", async () => {
		const { kp, wdk, sealed } = await fixture();
		expect(await openWdk(sealed, kp.privateKey, INFO)).toEqual(wdk);
	});

	// .buffer is the WHOLE backing store, so any view over a larger buffer used
	// to seal allocator residue instead of the WDK -- and still round-trip.
	it("seals a subarray view, not its whole backing buffer", async () => {
		const backing = crypto.getRandomValues(new Uint8Array(1024));
		const wdk = backing.subarray(32, 64);
		const { kp, sealed } = await fixture(wdk);
		expect(sealed.ciphertext).toHaveLength(wdk.length + 16);
		const opened = await openWdk(sealed, kp.privateKey, INFO);
		expect(opened).toHaveLength(32);
		expect(opened).toEqual(Uint8Array.from(wdk));
	});

	it("seals a pooled Node Buffer, not the pool behind it", async () => {
		const wdk = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
		expect(wdk.byteLength).toBeLessThan(wdk.buffer.byteLength);
		const { kp, sealed } = await fixture(wdk);
		expect(sealed.ciphertext).toHaveLength(48);
		expect(await openWdk(sealed, kp.privateKey, INFO)).toEqual(
			Uint8Array.from(wdk),
		);
	});

	it("opens enc and ciphertext carved out of one framing buffer", async () => {
		const { kp, wdk, sealed } = await fixture();
		const framed = new Uint8Array(sealed.enc.length + sealed.ciphertext.length);
		framed.set(sealed.enc, 0);
		framed.set(sealed.ciphertext, sealed.enc.length);
		const opened = await openWdk(
			{
				enc: framed.subarray(0, sealed.enc.length),
				ciphertext: framed.subarray(sealed.enc.length),
			},
			kp.privateKey,
			INFO,
		);
		expect(opened).toEqual(wdk);
	});

	it("mints a fresh encapsulated key per seal", async () => {
		const kp = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const a = await sealWdk(wdk, kp.publicKey, INFO);
		const b = await sealWdk(wdk, kp.publicKey, INFO);
		expect(a.enc).not.toEqual(b.enc);
		expect(a.ciphertext).not.toEqual(b.ciphertext);
	});
});

describe("openWdk rejections", () => {
	it.each([
		["workspace", { workspaceId: "ws_2" }],
		["key version", { keyVersion: 2 }],
		["recipient", { recipientUserId: "u_2" }],
		["fingerprint", { recipientFingerprint: "fp_2" }],
	] as const)("refuses a wrap addressed to a different %s", async (_, patch) => {
		const { kp, sealed } = await fixture();
		const e = await openFailure(() =>
			openWdk(sealed, kp.privateKey, { ...INFO, ...patch }),
		);
		expect(e.reason).toBe("cannot-open");
	});

	it("refuses a wrap opened with the wrong private key", async () => {
		const { sealed } = await fixture();
		const other = await suite.kem.generateKeyPair();
		const e = await openFailure(() => openWdk(sealed, other.privateKey, INFO));
		expect(e.reason).toBe("cannot-open");
	});

	it("refuses a truncated ciphertext", async () => {
		const { kp, sealed } = await fixture();
		const e = await openFailure(() =>
			openWdk(
				{ ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) },
				kp.privateKey,
				INFO,
			),
		);
		expect(e.reason).toBe("cannot-open");
	});

	it("refuses a tampered encapsulated key", async () => {
		const { kp, sealed } = await fixture();
		const enc = Uint8Array.from(sealed.enc);
		enc[0] ^= 0xff;
		const e = await openFailure(() =>
			openWdk({ ...sealed, enc }, kp.privateKey, INFO),
		);
		expect(e.reason).toBe("cannot-open");
	});

	it("reports a structurally malformed encapsulated key distinctly", async () => {
		const { kp, sealed } = await fixture();
		const e = await openFailure(() =>
			openWdk({ ...sealed, enc: sealed.enc.slice(0, 16) }, kp.privateKey, INFO),
		);
		expect(e.reason).toBe("malformed");
		expect(e.message).toMatch(/^hpke:/);
	});
});
