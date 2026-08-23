// Shell flow 2 / section 9. Four discrete choices, never a number input plus a
// unit: no locale then has to inflect a duration against a user-entered
// integer, and the stored value cannot drift to something the UI has no label
// for.
export const AUTO_LOCK_CHOICES = [15, 60, 480, 0] as const;

export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];

// Not zero, and not "never". A key sitting unlocked forever on a shared laptop
// is the case the max age exists for, so the unset default has to be a real
// timeout rather than the most permissive option.
export const DEFAULT_AUTO_LOCK_MINUTES: AutoLockMinutes = 15;

export function isAutoLockMinutes(value: unknown): value is AutoLockMinutes {
	return (AUTO_LOCK_CHOICES as readonly unknown[]).includes(value);
}

/**
 * Minutes to the keyring's `maxAgeMs`. `0` is "never", which is represented as
 * Infinity rather than 0 -- a 0 ms max age would expire the key on the same
 * tick it was unlocked, turning the most permissive choice into the strictest
 * one.
 */
export function autoLockMaxAgeMs(minutes: number | null | undefined): number {
	const resolved = isAutoLockMinutes(minutes)
		? minutes
		: DEFAULT_AUTO_LOCK_MINUTES;
	return resolved === 0 ? Number.POSITIVE_INFINITY : resolved * 60_000;
}
