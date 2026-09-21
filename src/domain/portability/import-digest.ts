import type { PortableJson } from "./v1.ts";

export function canonicalImportJson(
	value: PortableJson,
	checkpoint?: () => void,
): string {
	checkpoint?.();
	if (Array.isArray(value))
		return `[${value.map((child) => canonicalImportJson(child, checkpoint)).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonicalImportJson(value[key], checkpoint)}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}

export async function hashImportValue(
	domain: string,
	value: PortableJson,
	checkpoint: () => void,
): Promise<string> {
	checkpoint();
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalImportJson([domain, value], checkpoint)),
	);
	checkpoint();
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
