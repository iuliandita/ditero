import { z } from "zod";
import { randomId } from "../../domain/random-id.ts";
import { clampFocusConfig, type FocusConfig } from "./timer-core.ts";

const instant = z.number().finite().nonnegative().max(8.64e15);
const sessionSchema = z
	.object({
		intervalId: z.uuid(),
		cycle: z.object({
			phase: z.enum(["work", "break"]),
			round: z.number().int().min(1),
			isLongBreak: z.boolean(),
		}),
		plannedSec: z.number().int().min(1).max(10800),
		running: z.boolean(),
		startedAt: instant.nullable(),
		endsAt: instant.nullable(),
		pausedAt: instant.nullable(),
		remainingSec: z.number().int().nonnegative().max(10800),
		boundTaskId: z.string().max(1024).nullable(),
		boundTaskTitle: z.string().max(10000).nullable(),
		config: z.unknown().transform(clampFocusConfig),
	})
	.refine(
		(s) =>
			s.remainingSec <= s.plannedSec &&
			(s.running
				? s.startedAt !== null &&
					s.endsAt !== null &&
					s.endsAt >= s.startedAt &&
					s.pausedAt === null
				: s.endsAt === null),
	);

export type FocusSessionState = z.infer<typeof sessionSchema>;
const completionSchema = z
	.object({
		intervalId: z.uuid(),
		taskId: z.string().max(1024).optional(),
		kind: z.enum(["work", "break"]),
		startedAt: instant,
		endedAt: instant,
		durationSec: z.number().int().min(1).max(10800),
	})
	.refine(
		(s) =>
			s.endedAt >= s.startedAt &&
			s.durationSec <= Math.ceil((s.endedAt - s.startedAt) / 1000) + 1,
	);
export type FocusCompletion = z.infer<typeof completionSchema>;
export type FocusState = {
	session: FocusSessionState | null;
	pendingCompletions: FocusCompletion[];
};
const storedSchema = z.object({
	version: z.literal(1),
	revision: z.uuid().optional(),
	session: sessionSchema.nullable(),
	pendingCompletions: z.array(completionSchema).default([]),
});
export function focusStorageKey(userId: string, scope?: string): string {
	return `ditero:focus:${JSON.stringify([scope ?? "browser", userId])}`;
}
export function restoreFocus(raw: string | null): FocusSessionState | null {
	return restoreFocusState(raw).session;
}
export function restoreFocusState(raw: string | null): FocusState {
	try {
		return storedSchema.parse(JSON.parse(raw ?? "null"));
	} catch {
		return { session: null, pendingCompletions: [] };
	}
}
export function serializeFocus(
	session: FocusSessionState | null,
	pendingCompletions: FocusCompletion[] = [],
): string {
	return JSON.stringify({
		version: 1,
		revision: randomId(),
		session,
		pendingCompletions,
	});
}
export function intervalFields(config: FocusConfig) {
	return { intervalId: randomId(), pausedAt: null, config };
}
