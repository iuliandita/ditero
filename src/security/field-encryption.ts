import {
	createCipheriv,
	createDecipheriv,
	createHash,
	hkdfSync,
	randomBytes,
} from "node:crypto";

type FieldKey = {
	fingerprint: string;
	key: Buffer;
};

export type FieldKeyRing = {
	readKeys: FieldKey[];
	writeKey: FieldKey;
};

function decodeKey(value: string): Buffer {
	const key = Buffer.from(value, "base64");
	if (key.length !== 32 || key.toString("base64") !== value) {
		throw new Error("Field encryption keys must decode to exactly 32 bytes");
	}
	return key;
}

function deriveKey(key: Buffer): Buffer {
	return Buffer.from(
		hkdfSync("sha256", key, Buffer.alloc(0), "ditero:field-encryption:v1", 32),
	);
}

function fieldKey(value: string): FieldKey {
	return {
		fingerprint: fingerprintKey(value),
		key: deriveKey(decodeKey(value)),
	};
}

export function fingerprintKey(value: string): string {
	return createHash("sha256")
		.update(decodeKey(value))
		.digest("base64url")
		.slice(0, 16);
}

export function createFieldKeyRing(input: {
	current: string;
	next?: string;
}): FieldKeyRing {
	const current = fieldKey(input.current);
	const next = input.next ? fieldKey(input.next) : undefined;
	return {
		writeKey: next ?? current,
		readKeys: next ? [next, current] : [current],
	};
}

function associatedData(context: string): Buffer {
	if (!context) throw new Error("Encryption context is required");
	return Buffer.from(`ditero:field-encryption:v1:${context}`, "utf8");
}

export function encryptField(
	plaintext: string,
	context: string,
	ring: FieldKeyRing,
): string {
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", ring.writeKey.key, nonce);
	cipher.setAAD(associatedData(context));
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return [
		"ditero",
		"v1",
		ring.writeKey.fingerprint,
		nonce.toString("base64url"),
		ciphertext.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
	].join(":");
}

export function decryptField(
	envelope: string,
	context: string,
	ring: FieldKeyRing,
): { plaintext: string; needsRotation: boolean } {
	const [prefix, version, fingerprint, nonceValue, ciphertextValue, tagValue] =
		envelope.split(":");
	if (
		prefix !== "ditero" ||
		version !== "v1" ||
		!fingerprint ||
		!nonceValue ||
		ciphertextValue === undefined ||
		!tagValue ||
		envelope.split(":").length !== 6
	) {
		throw new Error("Invalid encrypted field envelope");
	}
	const nonce = Buffer.from(nonceValue, "base64url");
	const ciphertext = Buffer.from(ciphertextValue, "base64url");
	const tag = Buffer.from(tagValue, "base64url");
	if (nonce.length !== 12 || tag.length !== 16) {
		throw new Error("Invalid encrypted field envelope");
	}

	const keys = [...ring.readKeys].sort(
		(left, right) =>
			Number(right.fingerprint === fingerprint) -
			Number(left.fingerprint === fingerprint),
	);
	for (const candidate of keys) {
		try {
			const decipher = createDecipheriv("aes-256-gcm", candidate.key, nonce);
			decipher.setAAD(associatedData(context));
			decipher.setAuthTag(tag);
			const plaintext = Buffer.concat([
				decipher.update(ciphertext),
				decipher.final(),
			]).toString("utf8");
			return {
				plaintext,
				needsRotation:
					candidate.fingerprint !== ring.writeKey.fingerprint ||
					fingerprint !== candidate.fingerprint,
			};
		} catch {}
	}
	throw new Error("Encrypted field authentication failed");
}

export function reencryptField(
	envelope: string,
	context: string,
	ring: FieldKeyRing,
): string {
	const result = decryptField(envelope, context, ring);
	return result.needsRotation
		? encryptField(result.plaintext, context, ring)
		: envelope;
}

export function hashPAT(token: string): string {
	return `pat:v1:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}
