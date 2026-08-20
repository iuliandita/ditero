import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

export type WdkInfo = {
	workspaceId: string;
	keyVersion: number;
	recipientUserId: string;
	recipientFingerprint: string;
};

export type SealedWdk = {
	enc: Uint8Array;
	ciphertext: Uint8Array;
};

// One suite instance per call is deliberate: a module-scope suite is fine here
// today, but the browser bundle shares this module across tabs and a stateful
// suite would be a foot-gun the moment the library gains per-context state.
export function hpkeSuite(): CipherSuite {
	return new CipherSuite({
		kem: new DhkemX25519HkdfSha256(),
		kdf: new HkdfSha256(),
		aead: new Chacha20Poly1305(),
	});
}

// Binds the wrap to exactly one (workspace, version, recipient, key). Without
// this a wrap can be replayed onto another workspace or another member. It does
// NOT authenticate the sender -- HPKE base mode has none -- which is why the
// commitment in wdk-commitment.ts exists.
export function wdkInfo(info: WdkInfo): Uint8Array {
	return new TextEncoder().encode(
		[
			"ditero:wdk:v1",
			info.workspaceId,
			String(info.keyVersion),
			info.recipientUserId,
			info.recipientFingerprint,
		].join("|"),
	);
}

export async function sealWdk(
	wdk: Uint8Array,
	recipientPublicKey: CryptoKey,
	info: WdkInfo,
): Promise<SealedWdk> {
	const suite = hpkeSuite();
	const sender = await suite.createSenderContext({
		recipientPublicKey,
		info: wdkInfo(info).buffer as ArrayBuffer,
	});
	const ciphertext = await sender.seal(wdk.buffer as ArrayBuffer);
	return {
		enc: new Uint8Array(sender.enc),
		ciphertext: new Uint8Array(ciphertext),
	};
}

export async function openWdk(
	sealed: SealedWdk,
	recipientKey: CryptoKey,
	info: WdkInfo,
): Promise<Uint8Array> {
	const suite = hpkeSuite();
	const recipient = await suite.createRecipientContext({
		recipientKey,
		enc: sealed.enc.buffer as ArrayBuffer,
		info: wdkInfo(info).buffer as ArrayBuffer,
	});
	return new Uint8Array(
		await recipient.open(sealed.ciphertext.buffer as ArrayBuffer),
	);
}
