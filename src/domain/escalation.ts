export type EscalationPolicy = {
	repeatEveryMin: number | null;
	maxRepeats: number | null;
	fallbackUserId: string | null;
	// Not read here: quiet-hours and dispatch consume it directly. It rides
	// along on the policy type only because it travels with the rest of it.
	urgent: boolean;
};

// fireCount is the number of times this reminder has already been sent to
// its primary recipient (the initial send counts as 1), not the number of
// repeats past the first. So with maxRepeats: 3, fireCount runs 1, 2, 3 as
// "repeat" (three sends total), then fireCount === 3 == cap triggers a
// one-shot handoff to the fallback -- not a fourth repeat to the recipient.
export type EscalationState = { fireCount: number };

export type EscalationAction =
	| { kind: "repeat"; at: Date }
	// The caller marks the original reminder_state 'escalated' (terminal,
	// alongside acked/failed/expired) and creates a sibling reminder_state
	// for userId carrying the same repeat policy but fallbackUserId: null.
	// So the fallback is reminded on the same repeat cadence as the
	// original recipient was -- what it loses is the ability to escalate
	// again, which is what keeps the chain from cycling.
	| { kind: "escalate"; userId: string }
	| { kind: "terminal"; reason: "exhausted" | "no_repeat" };

export function nextEscalation(
	state: EscalationState,
	policy: EscalationPolicy,
	now: Date,
): EscalationAction {
	if (!Number.isInteger(state.fireCount) || state.fireCount < 0) {
		throw new Error(
			`escalation: invalid fireCount ${state.fireCount}, expected a non-negative integer`,
		);
	}

	if (policy.repeatEveryMin === null) {
		return { kind: "terminal", reason: "no_repeat" };
	}
	if (!Number.isInteger(policy.repeatEveryMin) || policy.repeatEveryMin <= 0) {
		throw new Error(
			`escalation: invalid repeatEveryMin ${policy.repeatEveryMin}, expected a positive integer`,
		);
	}

	// task.max_repeats is nullable in the schema to mean "inherit the
	// user-level default" -- that inheritance must be resolved by the
	// caller before building an EscalationPolicy. A null here with repeats
	// enabled means the caller skipped resolution; failing loud beats
	// silently collapsing it to 0 (which would exhaust every policy on its
	// very first fire).
	if (policy.maxRepeats === null) {
		throw new Error(
			"escalation: maxRepeats is null with repeatEveryMin set -- resolve the user-level default before calling nextEscalation",
		);
	}
	if (!Number.isInteger(policy.maxRepeats) || policy.maxRepeats < 0) {
		throw new Error(
			`escalation: invalid maxRepeats ${policy.maxRepeats}, expected a non-negative integer`,
		);
	}

	if (state.fireCount < policy.maxRepeats) {
		return {
			kind: "repeat",
			at: new Date(now.getTime() + policy.repeatEveryMin * 60_000),
		};
	}
	if (state.fireCount === policy.maxRepeats && policy.fallbackUserId) {
		return { kind: "escalate", userId: policy.fallbackUserId };
	}
	return { kind: "terminal", reason: "exhausted" };
}
