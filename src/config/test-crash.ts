// Deliberate process-suicide seam for the durability rig (Task 16).
//
// The window this exists for -- provider accepted the send, local commit has
// not happened yet -- is sub-millisecond, so an external SIGKILL can never land
// in it. The only way to prove the at-least-once claim the docs make is for the
// process to kill ITSELF at a named point.
//
// Inert unless BOTH: the process is not production AND the variable is set.
// Resolved once, at boot, so a variable that appears later in a running
// process's environment cannot arm anything.
export const CRASH_POINTS = [
	"before-send",
	"after-send",
	"mid-claim",
	"mid-scan",
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

export type CrashHook = (point: CrashPoint) => void;

const NOOP: CrashHook = () => {};

function isCrashPoint(value: string): value is CrashPoint {
	return (CRASH_POINTS as readonly string[]).includes(value);
}

// SIGKILL, not exit(): an orderly shutdown would let in-flight work settle,
// which is the opposite of what the rig needs to observe.
const suicide = () => process.kill(process.pid, "SIGKILL");

export function crashHook(
	env: Record<string, string | undefined>,
	kill: () => void = suicide,
): CrashHook {
	if (env.NODE_ENV === "production") return NOOP;
	const raw = env.DITERO_TEST_CRASH_POINT?.trim();
	if (!raw) return NOOP;
	if (!isCrashPoint(raw)) {
		throw new Error(
			`DITERO_TEST_CRASH_POINT: expected one of ${CRASH_POINTS.join(", ")}, got "${raw}"`,
		);
	}
	return (point) => {
		if (point === raw) kill();
	};
}
