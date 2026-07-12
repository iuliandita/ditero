import { generateKeyBetween } from "fractional-indexing";

// No leading '0': a trailing '0' fraction digit is an invalid order key
// (fractional-indexing forbids trailing zeros), and jitter is always suffixed.
const JITTER = "123456789abcdefghijklmnopqrstuvwxyz";
const jitter = () =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(3)),
		(b) => JITTER[b % JITTER.length],
	).join("");

const JITTER_ATTEMPTS = 5;

// Jitter suffix makes concurrent same-slot inserts collision-free (2.8a).
// A jittered key can overshoot `b` when the base key is a prefix of it;
// retry with fresh jitter, deepening the base (midpoint toward `b`) on
// exhaustion so the result stays jittered and collision-free. Terminates:
// each deepen strictly narrows base..b until a jitter char fits below `b`.
// Strip nothing on read: keys are opaque, only ordering matters.
export function keyBetween(a: string | null, b: string | null): string {
	let base = generateKeyBetween(a, b);
	for (;;) {
		for (let i = 0; i < JITTER_ATTEMPTS; i++) {
			const candidate = base + jitter();
			if (b == null || candidate < b) return candidate;
		}
		base = generateKeyBetween(base, b);
	}
}

export const keysAreOrdered = (keys: string[]): boolean =>
	keys.every((k, i) => i === 0 || keys[i - 1] < k);
