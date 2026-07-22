// Shared by every HTTP adapter: providers report a wait either as a
// Retry-After header (a string, or null when absent) or inside a JSON envelope
// (already a number, or whatever the remote felt like sending). One parser for
// both so the adapters cannot drift on what an unusable value means.
export function retryAfterSeconds(value: unknown): number | undefined {
	const seconds =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	// classifyRetry falls back to its own backoff when retryAfterSec is absent,
	// and clamps hostile values; an unparseable one must not become 0, which
	// Number("") and Number("   ") would otherwise produce.
	return Number.isFinite(seconds) ? seconds : undefined;
}
