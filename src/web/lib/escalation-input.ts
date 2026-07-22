import {
	MAX_REPEAT_EVERY_MIN,
	MAX_REPEATS_CAP,
} from "../../domain/escalation-policy.ts";

// Shared by the user-level defaults form and the per-task override form: both
// write the same three columns through the same caps, and having two copies is
// what let the inputs say max=20 while the constant said something else.
export const REPEAT_EVERY_MIN_MAX = MAX_REPEAT_EVERY_MIN;
export const REPEATS_MAX = MAX_REPEATS_CAP;

// Empty clears the override (null => inherit). Values outside the mutator's
// range are clamped rather than sent: typing "0" into a field the mutator
// requires to be positive would otherwise produce a rejected write instead of
// simply being unreachable.
export function repeatEveryMinInput(value: string): number | null {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return null;
	return Math.min(Math.max(n, 1), REPEAT_EVERY_MIN_MAX);
}

export function maxRepeatsInput(value: string): number | null {
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) return null;
	return Math.min(Math.max(n, 0), REPEATS_MAX);
}
