import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { aadId, aadKeyVersion, joinAad, KEY_BYTES } from "./envelope.ts";

export type WdkInfo = {
	workspaceId: string;
	keyVersion: number;
	recipientUserId: string;
	recipientFingerprint: string;
};

// Framing is deliberately the caller's: the DB stores enc and ciphertext as two
// separate base64url columns, so there is nothing here to concatenate or parse.
export type SealedWdk = {
	enc: Uint8Array;
	ciphertext: Uint8Array;
};

export type WdkOpenFailure = "cannot-open" | "malformed";

// The UI must tell "this member is not a recipient of this key" apart from
// "this wrap is corrupt", and the leaf package signals them as two unrelated
// error classes from two different call sites.
export class WdkOpenError extends Error {
	constructor(
		readonly reason: WdkOpenFailure,
		cause: unknown,
	) {
		super(
			reason === "malformed"
				? "hpke: malformed WDK wrap"
				: "hpke: cannot open WDK wrap",
			{ cause },
		);
		this.name = "WdkOpenError";
	}
}

const suite = new CipherSuite({
	kem: new DhkemX25519HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Chacha20Poly1305(),
});

/** Test-only. The RFC 9180 vector proof needs the suite ids and raw key primitives. */
export function hpkeSuiteForTests(): CipherSuite {
	return suite;
}

export function importRecipientPublicKey(
	bytes: Uint8Array,
): Promise<CryptoKey> {
	return suite.kem.deserializePublicKey(bytes).catch((cause: unknown) => {
		throw new Error("hpke: malformed public key", { cause });
	});
}

export function importRecipientPrivateKey(
	bytes: Uint8Array,
): Promise<CryptoKey> {
	return suite.kem.deserializePrivateKey(bytes).catch((cause: unknown) => {
		throw new Error("hpke: malformed private key", { cause });
	});
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array(await suite.kem.serializePublicKey(key));
}

// Binds the wrap to exactly one (workspace, version, recipient, key). Without
// this a wrap can be replayed onto another workspace or another member. It does
// NOT authenticate the sender -- HPKE base mode has none -- which is why the
// commitment in wdk-commitment.ts exists.
export function wdkInfo(info: WdkInfo): Uint8Array {
	// Shared with envelope.ts rather than re-checked here: the hand-rolled copy
	// this replaces validated the separator but not the key version, so
	// `String(info.keyVersion)` emitted "NaN" or "1.5" into a binding that no
	// rotation could ever reproduce, leaving the WDK permanently unopenable.
	return joinAad([
		"ditero:wdk:v1",
		aadId("workspaceId", info.workspaceId),
		aadKeyVersion(info.keyVersion),
		aadId("recipientUserId", info.recipientUserId),
		aadId("recipientFingerprint", info.recipientFingerprint),
	]);
}

export async function sealWdk(
	wdk: Uint8Array,
	recipientPublicKey: CryptoKey,
	info: WdkInfo,
): Promise<SealedWdk> {
	// HPKE seals any payload, so a short WDK round-trips perfectly and only
	// fails later, at commitWdk, which requires the full length -- producing a
	// wrap no recipient can ever commit to. Same constant the commitment uses.
	if (wdk.length !== KEY_BYTES) {
		throw new Error(`hpke: WDK must be ${KEY_BYTES} bytes`);
	}
	const sender = await suite.createSenderContext({
		recipientPublicKey,
		info: wdkInfo(info),
	});
	return {
		enc: new Uint8Array(sender.enc),
		ciphertext: new Uint8Array(await sender.seal(wdk)),
	};
}

export async function openWdk(
	sealed: SealedWdk,
	recipientKey: CryptoKey,
	info: WdkInfo,
): Promise<Uint8Array> {
	// Split by phase, not by error class: a wrap that cannot even be decapsulated
	// is structurally broken, while everything reaching open() is well-formed and
	// simply not addressed to this holder.
	const binding = wdkInfo(info);
	let recipient: Awaited<ReturnType<typeof suite.createRecipientContext>>;
	try {
		recipient = await suite.createRecipientContext({
			recipientKey,
			enc: sealed.enc,
			info: binding,
		});
	} catch (cause) {
		throw new WdkOpenError("malformed", cause);
	}
	try {
		return new Uint8Array(await recipient.open(sealed.ciphertext));
	} catch (cause) {
		throw new WdkOpenError("cannot-open", cause);
	}
}
