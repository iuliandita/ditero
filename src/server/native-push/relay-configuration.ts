import { createPublicKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { publicKey } from "../../../apps/push-relay/src/contracts.ts";
export type RelayConfiguration = {
	origin: string;
	receiptKeys: Record<string, z.infer<typeof publicKey>>;
};
export function relayConfiguration(
	env: NodeJS.ProcessEnv = process.env,
): RelayConfiguration | undefined {
	const origin = env.DITERO_NATIVE_PUSH_RELAY_ORIGIN,
		file = env.DITERO_NATIVE_PUSH_RELAY_RECEIPT_KEYS_FILE;
	if (!origin && !file) return undefined;
	if (!origin || !file)
		throw new Error("Incomplete native relay configuration");
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		url.origin !== origin ||
		url.username ||
		url.password
	)
		throw new Error("Invalid native relay origin");
	const info = statSync(file);
	if (
		!info.isFile() ||
		info.size > 16384 ||
		(process.platform !== "win32" && (info.mode & 0o077) !== 0)
	)
		throw new Error("Native relay key file must be private and bounded");
	const receiptKeys = z
		.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), publicKey)
		.parse(JSON.parse(readFileSync(file, "utf8")));
	if (
		Object.keys(receiptKeys).length < 1 ||
		Object.keys(receiptKeys).length > 8
	)
		throw new Error("Invalid native relay receipt key ring");
	for (const key of Object.values(receiptKeys))
		createPublicKey({ key, format: "jwk" });
	return { origin, receiptKeys };
}
