import { createHmac } from "node:crypto";

function decodeBase32(value: string): Buffer {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = "";
	for (const character of value.replace(/=+$/, "").toUpperCase()) {
		const index = alphabet.indexOf(character);
		if (index < 0) throw new Error("invalid base32 secret");
		bits += index.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
		bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
	}
	return Buffer.from(bytes);
}

export function currentTOTP(secret: string): string {
	const counter = BigInt(Math.floor(Date.now() / 30_000));
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(counter);
	const digest = createHmac("sha1", decodeBase32(secret))
		.update(message)
		.digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const value =
		(((digest[offset] & 0x7f) << 24) |
			(digest[offset + 1] << 16) |
			(digest[offset + 2] << 8) |
			digest[offset + 3]) %
		1_000_000;
	return value.toString().padStart(6, "0");
}
