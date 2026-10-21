import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

export type AuthSecretRotation = { current: string; next: string };

export async function rotateAuthSecretValue(
	value: string,
	model: string,
	secrets: AuthSecretRotation,
): Promise<string> {
	if (model !== "jwks" && model !== "twoFactor") return value;
	try {
		const ciphertext: unknown = model === "jwks" ? JSON.parse(value) : value;
		if (typeof ciphertext !== "string")
			throw new Error("Invalid auth ciphertext");
		// Reruns must not encrypt a value twice or require retired secrets.
		try {
			await symmetricDecrypt({ key: secrets.next, data: ciphertext });
			return value;
		} catch {}
		const plaintext = await symmetricDecrypt({
			key: secrets.current,
			data: ciphertext,
		});
		const rotated = await symmetricEncrypt({
			key: secrets.next,
			data: plaintext,
		});
		return model === "jwks" ? JSON.stringify(rotated) : rotated;
	} catch {
		throw new Error(
			"Auth secret rotation could not decrypt a stored value; restore the original BETTER_AUTH_SECRET and follow docs/runbooks/key-rotation.md",
		);
	}
}
