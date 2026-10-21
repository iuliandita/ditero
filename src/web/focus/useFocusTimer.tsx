import { useZero } from "@rocicorp/zero/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { useUserPref } from "../hooks/useUserPref.ts";
import { useNativeAccount } from "../lib/native-account.tsx";
import { runMutation } from "../lib/run-mutation.ts";
import {
	type Cycle,
	clampFocusConfig,
	type FocusConfig,
	INITIAL_CYCLE,
	nextCycle,
	phaseDurationSec,
	remainingSecFrom,
} from "./timer-core.ts";
import {
	focusStorageKey,
	intervalFields,
	restoreFocus,
	type FocusSessionState as Session,
	serializeFocus,
} from "./timer-persistence.ts";

type Cue = { id: number; text: string };

export type FocusTimerApi = {
	session: Session | null;
	config: FocusConfig;
	roundsPerLongBreak: number;
	cue: Cue | null;
	start: () => void;
	pause: () => void;
	reset: () => void;
	skip: () => void;
	bindTask: (taskId: string | null, title: string | null) => void;
	startForTask: (taskId: string, title: string) => void;
};

const FocusContext = createContext<FocusTimerApi | null>(null);

const CUE_MS = 5000;

// e2e time seam (development and explicit test builds): a short interval length so the timer completes
// in seconds instead of minutes without faking the whole page clock (which Zero's
// sync loop rides on). Production builds tree-shake this branch out.
function testOverrideSec(): number | null {
	if (!import.meta.env.DEV && import.meta.env.MODE !== "test") return null;
	const v = (globalThis as { __diteroFocusTestSec?: unknown })
		.__diteroFocusTestSec;
	return typeof v === "number" && v > 0 ? v : null;
}

export function FocusProvider({ children }: { children: ReactNode }) {
	const zero = useZero<typeof schema>();
	const userId = zero.userID;
	if (!userId) throw new Error("FocusProvider requires a signed-in user");
	const { pref, loading } = useUserPref();
	const prefLoadingRef = useRef(loading);
	prefLoadingRef.current = loading;
	const native = useNativeAccount();
	const storageKey = focusStorageKey(userId, native?.storageScope);
	const config = useMemo(() => clampFocusConfig(pref.focus), [pref.focus]);
	const configRef = useRef(config);
	configRef.current = config;

	const [session, setSessionState] = useState<Session | null>(() => {
		try {
			return restoreFocus(localStorage.getItem(storageKey));
		} catch {
			return null;
		}
	});
	const sessionRef = useRef(session);
	sessionRef.current = session;

	// Persist transitions synchronously, including Stop and completion, so an
	// immediate reload cannot revive the previous interval. Keep side effects out
	// of React state updaters, which Strict Mode may invoke twice.
	const setSession = useCallback(
		(
			update: Session | null | ((previous: Session | null) => Session | null),
		) => {
			const next =
				typeof update === "function" ? update(sessionRef.current) : update;
			if (next === sessionRef.current) return;
			sessionRef.current = next;
			try {
				if (next) localStorage.setItem(storageKey, serializeFocus(next));
				else localStorage.removeItem(storageKey);
			} catch (error) {
				console.error("Could not persist focus timer", error);
			}
			setSessionState(next);
		},
		[storageKey],
	);

	useEffect(() => {
		const current = sessionRef.current;
		if (
			!loading &&
			current &&
			JSON.stringify(current.config) !== JSON.stringify(config)
		) {
			setSession({ ...current, config });
		}
	}, [loading, config, setSession]);

	const [cue, setCue] = useState<Cue | null>(null);
	const cueIdRef = useRef(0);

	const plannedFor = useCallback((cycle: Cycle, cfg: FocusConfig): number => {
		return testOverrideSec() ?? phaseDurationSec(cycle, cfg);
	}, []);

	const showCue = useCallback((text: string) => {
		cueIdRef.current += 1;
		setCue({ id: cueIdRef.current, text });
	}, []);

	// Auto-clear the end-of-interval cue after a few seconds.
	useEffect(() => {
		if (!cue) return;
		const id = setTimeout(() => {
			setCue((c) => (c && c.id === cue.id ? null : c));
		}, CUE_MS);
		return () => clearTimeout(id);
	}, [cue]);

	// Natural interval completion: log the finished interval, cue, then advance
	// (auto-cycle) or park paused on the next phase awaiting the user.
	const complete = useCallback(() => {
		const s = sessionRef.current;
		if (!s || s.startedAt == null) return;
		const cfg = prefLoadingRef.current ? s.config : configRef.current;
		const kind = s.cycle.phase;
		const durationSec = s.plannedSec;
		// Only completed, positive intervals log; a reset never reaches here.
		if (durationSec >= 1) {
			const startedAt = s.startedAt;
			const endedAt = s.endsAt ?? startedAt + durationSec * 1000;
			const taskId = kind === "work" ? s.boundTaskId : null;
			void runMutation(
				zero.mutate(
					mutators.focus.logSession({
						intervalId: s.intervalId,
						...(taskId ? { taskId } : {}),
						kind,
						startedAt,
						endedAt,
						durationSec,
					}),
				),
				(msg) => console.error("focus.logSession failed", msg),
			);
		}
		showCue(
			kind === "work" ? m.focus_cue_work_complete() : m.focus_cue_break_over(),
		);

		const next = nextCycle(s.cycle, cfg);
		const nextSec = plannedFor(next, cfg);
		if (cfg.autoCycle) {
			const now = Date.now();
			setSession({
				...intervalFields(cfg),
				cycle: next,
				plannedSec: nextSec,
				running: true,
				startedAt: now,
				endsAt: now + nextSec * 1000,
				remainingSec: nextSec,
				boundTaskId: s.boundTaskId,
				boundTaskTitle: s.boundTaskTitle,
			});
		} else {
			setSession({
				...intervalFields(cfg),
				cycle: next,
				plannedSec: nextSec,
				running: false,
				startedAt: null,
				endsAt: null,
				remainingSec: nextSec,
				boundTaskId: s.boundTaskId,
				boundTaskTitle: s.boundTaskTitle,
			});
		}
	}, [zero, plannedFor, showCue, setSession]);

	// Tick while running: remaining is recomputed from `endsAt` each tick (not
	// decremented), so a throttled/suspended tab catches up on the next fire.
	// setState only when the whole-second value changes, so the aria-live phase
	// region is not thrashed.
	useEffect(() => {
		if (!session?.running) return;
		function tick() {
			const s = sessionRef.current;
			if (!s?.running || s.endsAt == null) return;
			const now = Date.now();
			if (now >= s.endsAt) {
				complete();
				return;
			}
			const rem = remainingSecFrom(s.endsAt, now);
			setSession((prev) =>
				prev?.running && prev.remainingSec !== rem
					? { ...prev, remainingSec: rem }
					: prev,
			);
		}
		tick();
		const id = setInterval(tick, 250);
		return () => clearInterval(id);
	}, [session?.running, complete, setSession]);

	const start = useCallback(() => {
		setSession((prev) => {
			const cfg = configRef.current;
			if (!prev) {
				const sec = plannedFor(INITIAL_CYCLE, cfg);
				const now = Date.now();
				return {
					...intervalFields(cfg),
					cycle: INITIAL_CYCLE,
					plannedSec: sec,
					running: true,
					startedAt: now,
					endsAt: now + sec * 1000,
					remainingSec: sec,
					boundTaskId: null,
					boundTaskTitle: null,
				};
			}
			if (prev.running) return prev;
			const now = Date.now();
			return {
				...prev,
				running: true,
				startedAt: prev.startedAt ?? now,
				pausedAt: null,
				endsAt: now + prev.remainingSec * 1000,
			};
		});
	}, [plannedFor, setSession]);

	const pause = useCallback(() => {
		setSession((prev) => {
			if (!prev?.running || prev.endsAt == null) return prev;
			return {
				...prev,
				running: false,
				pausedAt: Date.now(),
				endsAt: null,
				remainingSec: remainingSecFrom(prev.endsAt, Date.now()),
			};
		});
	}, [setSession]);

	// Stop and discard: a mid-interval reset must NOT log a session.
	const reset = useCallback(() => {
		setSession(null);
		setCue(null);
	}, [setSession]);

	// Advance to the next phase without logging (an explicit skip is not a natural
	// completion).
	const skip = useCallback(() => {
		setSession((prev) => {
			if (!prev) return prev;
			const cfg = configRef.current;
			const next = nextCycle(prev.cycle, cfg);
			const sec = plannedFor(next, cfg);
			if (prev.running) {
				const now = Date.now();
				return {
					...prev,
					...intervalFields(cfg),
					cycle: next,
					plannedSec: sec,
					startedAt: now,
					endsAt: now + sec * 1000,
					remainingSec: sec,
				};
			}
			return {
				...prev,
				...intervalFields(cfg),
				cycle: next,
				plannedSec: sec,
				startedAt: null,
				endsAt: null,
				remainingSec: sec,
			};
		});
	}, [plannedFor, setSession]);

	const bindTask = useCallback(
		(taskId: string | null, title: string | null) => {
			setSession((prev) =>
				prev ? { ...prev, boundTaskId: taskId, boundTaskTitle: title } : prev,
			);
		},
		[setSession],
	);

	// "Start focus" from a task: rebind a running session (don't discard progress),
	// else start a fresh work interval bound to the task.
	const startForTask = useCallback(
		(taskId: string, title: string) => {
			setSession((prev) => {
				if (prev?.running) {
					return { ...prev, boundTaskId: taskId, boundTaskTitle: title };
				}
				const cfg = configRef.current;
				const sec = plannedFor(INITIAL_CYCLE, cfg);
				const now = Date.now();
				return {
					...intervalFields(cfg),
					cycle: INITIAL_CYCLE,
					plannedSec: sec,
					running: true,
					startedAt: now,
					endsAt: now + sec * 1000,
					remainingSec: sec,
					boundTaskId: taskId,
					boundTaskTitle: title,
				};
			});
		},
		[plannedFor, setSession],
	);

	const api = useMemo<FocusTimerApi>(
		() => ({
			session,
			config,
			roundsPerLongBreak: config.roundsPerLongBreak,
			cue,
			start,
			pause,
			reset,
			skip,
			bindTask,
			startForTask,
		}),
		[session, config, cue, start, pause, reset, skip, bindTask, startForTask],
	);

	return <FocusContext.Provider value={api}>{children}</FocusContext.Provider>;
}

export function useFocusTimer(): FocusTimerApi {
	const ctx = useContext(FocusContext);
	if (!ctx) throw new Error("useFocusTimer used outside FocusProvider");
	return ctx;
}
