import { z } from "zod";
import { randomId } from "../../domain/random-id.ts";
import { clampFocusConfig, type FocusConfig } from "./timer-core.ts";

// Server cap on reported pauses (focus.logSession); longer pauses are clamped.
export const MAX_PAUSED_MS = 86_400_000;
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
		remainingSec: z.number().int().nonnegative().max(10800),
		provenMs: z.number().finite().nonnegative().max(10800000).default(0),
		pausedMs: z.number().finite().nonnegative().max(MAX_PAUSED_MS).default(0),
		serverStarted: z.boolean().default(false),
		boundTaskId: z.string().max(1024).nullable(),
		boundTaskTitle: z.string().max(10000).nullable(),
		config: z.unknown().transform(clampFocusConfig),
	})
	.refine(
		(s) =>
			s.remainingSec <= s.plannedSec &&
			s.provenMs <= s.plannedSec * 1000 &&
			(s.running
				? s.startedAt !== null && s.endsAt !== null && s.endsAt >= s.startedAt
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
		pausedMs: z.number().int().min(0).max(MAX_PAUSED_MS).optional(),
	})
	.refine(
		(s) =>
			s.endedAt >= s.startedAt &&
			s.durationSec <= Math.ceil((s.endedAt - s.startedAt) / 1000) + 1,
	);
export type FocusCompletion = z.infer<typeof completionSchema>;
const storedSchema = z.object({
	version: z.literal(1),
	revision: z.number().int().nonnegative().safe(),
	session: sessionSchema.nullable(),
	pendingCompletions: z.array(completionSchema),
});
export type FocusState = z.infer<typeof storedSchema>;
export function emptyFocusState(): FocusState {
	return { version: 1, revision: 0, session: null, pendingCompletions: [] };
}
export function focusStorageKey(userId: string, scope?: string): string {
	return `ditero:focus:${JSON.stringify([scope ?? "browser", userId])}`;
}
export function intervalFields(config: FocusConfig) {
	return {
		intervalId: randomId(),
		config,
		provenMs: 0,
		pausedMs: 0,
		serverStarted: false,
	};
}

// A read/write transaction serializes actions across tabs, including completion
// and replay acknowledgement. localStorage carries only revision notifications.
export async function accessFocusState(
	key: string,
	update?: (state: FocusState) => FocusState,
): Promise<{ state: FocusState; changed: boolean }> {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("ditero-focus", 1);
		request.onupgradeneeded = () => request.result.createObjectStore("timers");
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(
				"timers",
				update ? "readwrite" : "readonly",
				{ durability: "strict" },
			);
			const store = transaction.objectStore("timers");
			let state = emptyFocusState();
			let changed = false;
			let failure: unknown;
			const request = store.get(key);
			request.onsuccess = () => {
				try {
					const parsed = storedSchema.safeParse(request.result);
					state = parsed.success ? parsed.data : emptyFocusState();
					const next = update?.(state) ?? state;
					if (next === state) return;
					state = storedSchema.parse({ ...next, revision: state.revision + 1 });
					store.put(state, key);
					changed = true;
				} catch (error) {
					failure = error;
					transaction.abort();
				}
			};
			transaction.oncomplete = () => resolve({ state, changed });
			transaction.onabort = () => reject(failure ?? transaction.error);
			transaction.onerror = () => {
				failure ??= transaction.error;
			};
		});
	} finally {
		db.close();
	}
}
