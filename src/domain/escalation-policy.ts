import { z } from "zod";
import type { EscalationPolicy } from "./escalation.ts";

// Applied only when repeats are enabled but neither the task nor the user says
// how many. null would throw inside nextEscalation and 0 would exhaust on the
// very first fire, so neither can serve as the floor of the merge.
export const DEFAULT_MAX_REPEATS = 3;

// Mirrors the cap the userPref.set write path applies. task.max_repeats is a
// bare smallint with no write-path cap yet, and repeatEveryMin: 1 with an
// uncapped repeat count is thousands of pushes at a real phone.
export const MAX_REPEATS_CAP = 20;

// A week. The column is a bare smallint (32767 minutes ~ 22 days), and a repeat
// interval beyond a week is indistinguishable from "never repeat", which the
// null case already expresses.
export const MAX_REPEAT_EVERY_MIN = 10_080;

export type TaskEscalationFields = {
	repeatEveryMin: number | null;
	maxRepeats: number | null;
	fallbackUserId: string | null;
	urgent: boolean;
};

// Extra keys are tolerated: the userPref.set schema is not strict, so a pref
// that was legitimately accepted at write time must not throw at fire time.
const storedDefaultsSchema = z.object({
	repeatEveryMin: z.number().int().positive().nullable().optional(),
	maxRepeats: z.number().int().min(0).nullable().optional(),
	fallbackUserId: z.string().nullable().optional(),
});

export type EscalationDefaults = z.infer<typeof storedDefaultsSchema>;

export function parseEscalationDefaults(value: unknown): EscalationDefaults {
	if (value === null || value === undefined) return {};
	const parsed = storedDefaultsSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			`escalation-policy: malformed user_pref.escalation_defaults: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
		);
	}
	return parsed.data;
}

// task-level over user-level over a hard-coded floor. A null task column means
// "inherit", never "disabled" -- collapsing the two is what makes every task
// with an unset max_repeats throw inside nextEscalation on every tick.
export function resolveEscalationPolicy(
	taskLevel: TaskEscalationFields,
	storedUserDefaults: unknown,
): EscalationPolicy {
	const userDefaults = parseEscalationDefaults(storedUserDefaults);

	const repeatEveryMin =
		taskLevel.repeatEveryMin ?? userDefaults.repeatEveryMin ?? null;
	const fallbackUserId =
		taskLevel.fallbackUserId ?? userDefaults.fallbackUserId ?? null;

	if (repeatEveryMin === null) {
		// nextEscalation short-circuits to terminal/no_repeat here and never
		// reads maxRepeats; carrying a resolved count would imply a repeat
		// schedule that does not exist.
		return {
			repeatEveryMin: null,
			maxRepeats: null,
			fallbackUserId,
			urgent: taskLevel.urgent,
		};
	}
	if (!Number.isInteger(repeatEveryMin) || repeatEveryMin <= 0) {
		throw new Error(
			`escalation-policy: invalid repeatEveryMin ${repeatEveryMin}, expected a positive integer`,
		);
	}

	const merged =
		taskLevel.maxRepeats ?? userDefaults.maxRepeats ?? DEFAULT_MAX_REPEATS;
	if (!Number.isInteger(merged) || merged < 0) {
		throw new Error(
			`escalation-policy: invalid maxRepeats ${merged}, expected a non-negative integer`,
		);
	}

	return {
		repeatEveryMin,
		maxRepeats: Math.min(merged, MAX_REPEATS_CAP),
		fallbackUserId,
		urgent: taskLevel.urgent,
	};
}
