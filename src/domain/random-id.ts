// crypto.randomUUID is gated to secure contexts, so it does not exist on a
// plain-HTTP origin that is not localhost -- which is exactly how a self-hoster
// first reaches the app on a LAN address. Every create is client-generated, so
// without a fallback the UI renders and then throws on the first list, task,
// label or comment. crypto.getRandomValues carries no such gate.
export function randomId(source: Crypto = globalThis.crypto): string {
	if (typeof source.randomUUID === "function") return source.randomUUID();
	if (typeof source.getRandomValues !== "function") {
		throw new Error("no cryptographic random source available");
	}
	const bytes = source.getRandomValues(new Uint8Array(16));
	// RFC 9562 §5.4: version 4 in the high nibble of octet 6, variant 10 in the
	// top bits of octet 8. Ids collide across clients without them.
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}
