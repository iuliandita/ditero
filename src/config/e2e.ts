import { booleanFlag } from "./env.ts";

// Design 14 keeps the whole milestone behind one switch, so the control plane
// (keys, grants, rotation) cannot ship without a payload to protect. Default
// off: an operator upgrading into a half-built feature should get today's
// behaviour, not a key subsystem nothing writes to yet.
//
// Task 8 gates /api/e2e/* and /api/attachments/* on this. The refusal must be
// 404, never 403: a 403 tells an unauthenticated prober the feature exists and
// is merely closed to them.
export function e2eEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return booleanFlag("DITERO_E2E_ENABLED", env.DITERO_E2E_ENABLED, false);
}
