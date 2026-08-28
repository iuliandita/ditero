// Deliberate process-suicide seam for the durability rig (Task 16).
//
// The window this exists for -- provider accepted the send, local commit has
// not happened yet -- is sub-millisecond, so an external SIGKILL can never land
// in it. The only way to prove the at-least-once claim the docs make is for the
// process to kill ITSELF at a named point.
//
// Armed only under an ALLOWLIST: NODE_ENV must be exactly "test" and the
// variable must be set. Deny by default is the point -- this is a self-hosted
// product, `bun src/server/index.ts` with no NODE_ENV at all is a normal way to
// run it, and the failure mode of a fail-open guard here is a server that
// SIGKILLs itself in a loop. Denying "production" and arming everything else
// (unset, "", "prod", "staging", a typo) would be exactly backwards.
//
// Resolved once, at boot, so a variable that appears later in a running
// process's environment cannot arm anything.
export const CRASH_POINTS = [
	"before-send",
	"after-send",
	"mid-claim",
	"mid-scan",
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

// `subject` names the row the hook is being offered, where the point has one.
// A crash point inside the outbox worker fires per row, and a batch carries rows
// the caller never asked about -- an overdue event notification for a task rides
// in the same batch as that task's reminder -- so an unscoped kill lands on a
// row the test has no way to observe (#186).
export type CrashHook = (point: CrashPoint, subject?: string | null) => void;

function isCrashPoint(value: string): value is CrashPoint {
	return (CRASH_POINTS as readonly string[]).includes(value);
}

// SIGKILL, not exit(): an orderly shutdown would let in-flight work settle,
// which is the opposite of what the rig needs to observe.
const suicide = () => process.kill(process.pid, "SIGKILL");

// `undefined` when inert, never a no-op closure: callers pass the result
// straight through as an optional hook, so "not armed" is an ABSENT option
// rather than a live function every production tick calls and awaits.
export function crashHook(
	env: Record<string, string | undefined>,
	kill: () => void = suicide,
): CrashHook | undefined {
	if (env.NODE_ENV !== "test") return undefined;
	const raw = env.DITERO_TEST_CRASH_POINT?.trim();
	if (!raw) return undefined;
	if (!isCrashPoint(raw)) {
		throw new Error(
			`DITERO_TEST_CRASH_POINT: expected one of ${CRASH_POINTS.join(", ")}, got "${raw}"`,
		);
	}
	// Empty is not a subject: an unset variable and one set to "" both mean
	// "any row", never "only the row with no id".
	const only = env.DITERO_TEST_CRASH_SUBJECT?.trim() || undefined;
	return (point, subject) => {
		if (point !== raw) return;
		if (only !== undefined && subject !== only) return;
		kill();
	};
}
