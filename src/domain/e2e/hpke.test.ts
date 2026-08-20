import { describe, expect, it } from "vitest";
import { hpkeSuite, openWdk, sealWdk, wdkInfo } from "./hpke.ts";
import vector from "./vectors/rfc9180-a2.json" with { type: "json" };

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

describe("hpke suite", () => {
	it("matches the RFC 9180 A.2 vector identity", () => {
		expect(hpkeSuite().kem.id).toBe(vector.kem_id);
		expect(hpkeSuite().kdf.id).toBe(vector.kdf_id);
		expect(hpkeSuite().aead.id).toBe(vector.aead_id);
	});

	it("decrypts the published ciphertext with the published receiver key", async () => {
		const suite = hpkeSuite();
		const rk = await suite.kem.deserializePrivateKey(hex(vector.skRm).buffer);
		const recipient = await suite.createRecipientContext({
			recipientKey: rk,
			enc: hex(vector.pkEm).buffer,
			info: hex(vector.info).buffer,
		});
		const pt = await recipient.open(
			hex(vector.encryptions[0].ct).buffer,
			hex(vector.encryptions[0].aad).buffer,
		);
		expect(Buffer.from(pt).toString("hex")).toBe(vector.encryptions[0].pt);
	});
});

describe("wdkInfo", () => {
	it("binds workspace, version, recipient and fingerprint", () => {
		const info = new TextDecoder().decode(
			wdkInfo({
				workspaceId: "ws_1",
				keyVersion: 2,
				recipientUserId: "u_1",
				recipientFingerprint: "fp_1",
			}),
		);
		expect(info).toBe("ditero:wdk:v1|ws_1|2|u_1|fp_1");
	});

	it("differs when any single component differs", () => {
		const base = {
			workspaceId: "ws_1",
			keyVersion: 2,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const variants = [
			{ ...base, workspaceId: "ws_2" },
			{ ...base, keyVersion: 3 },
			{ ...base, recipientUserId: "u_2" },
			{ ...base, recipientFingerprint: "fp_2" },
		];
		const seen = new Set(
			variants.map((v) => new TextDecoder().decode(wdkInfo(v))),
		);
		expect(seen.size).toBe(4);
		expect(seen.has(new TextDecoder().decode(wdkInfo(base)))).toBe(false);
	});
});

describe("sealWdk / openWdk", () => {
	it("round-trips a WDK to the holder of the private key", async () => {
		const suite = hpkeSuite();
		const kp = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const info = {
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const sealed = await sealWdk(wdk, kp.publicKey, info);
		expect(await openWdk(sealed, kp.privateKey, info)).toEqual(wdk);
	});

	it("refuses a wrap addressed to a different workspace", async () => {
		const suite = hpkeSuite();
		const kp = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const info = {
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const sealed = await sealWdk(wdk, kp.publicKey, info);
		await expect(
			openWdk(sealed, kp.privateKey, { ...info, workspaceId: "ws_2" }),
		).rejects.toThrow();
	});

	it("refuses a wrap addressed to a different key version", async () => {
		const suite = hpkeSuite();
		const kp = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const info = {
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const sealed = await sealWdk(wdk, kp.publicKey, info);
		await expect(
			openWdk(sealed, kp.privateKey, { ...info, keyVersion: 2 }),
		).rejects.toThrow();
	});

	it("refuses a wrap opened with the wrong private key", async () => {
		const suite = hpkeSuite();
		const kp = await suite.kem.generateKeyPair();
		const other = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const info = {
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const sealed = await sealWdk(wdk, kp.publicKey, info);
		await expect(openWdk(sealed, other.privateKey, info)).rejects.toThrow();
	});

	it("refuses a truncated ciphertext", async () => {
		const suite = hpkeSuite();
		const kp = await suite.kem.generateKeyPair();
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const info = {
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "u_1",
			recipientFingerprint: "fp_1",
		};
		const sealed = await sealWdk(wdk, kp.publicKey, info);
		await expect(
			openWdk(
				{ ...sealed, ciphertext: sealed.ciphertext.slice(0, -1) },
				kp.privateKey,
				info,
			),
		).rejects.toThrow();
	});
});
