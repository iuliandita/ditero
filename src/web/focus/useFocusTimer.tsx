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

// Ephemeral session state. Nothing here is persisted; only finished intervals are
// written (to focus_session, via the mutator). `endsAt` is the wall-clock end of
// the running interval and drives the countdown from timestamps (survives tab
// throttling); when paused it is null and `remainingSec` is authoritative.
type Session = {
	cycle: Cycle;
	plannedSec: number; // logged duration for this interval, independent of pauses
	running: boolean;
	startedAt: number | null; // ms; set when the interval first starts running
	endsAt: number | null; // ms; only while running
	remainingSec: number;
	boundTaskId: string | null;
	boundTaskTitle: string | null;
};

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

// e2e time seam (dev builds only): a short interval length so the timer completes
// in seconds instead of minutes without faking the whole page clock (which Zero's
// sync loop rides on). Production builds tree-shake this branch out.
function testOverrideSec(): number | null {
	if (!import.meta.env.DEV) return null;
	const v = (globalThis as { __diteroFocusTestSec?: unknown })
		.__diteroFocusTestSec;
	return typeof v === "number" && v > 0 ? v : null;
}

export function FocusProvider({ children }: { children: ReactNode }) {
	const zero = useZero<typeof schema>();
	const { pref } = useUserPref();
	const config = useMemo(() => clampFocusConfig(pref.focus), [pref.focus]);
	const configRef = useRef(config);
	configRef.current = config;

	const [session, setSession] = useState<Session | null>(null);
	const sessionRef = useRef(session);
	sessionRef.current = session;

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
		const cfg = configRef.current;
		const kind = s.cycle.phase;
		const durationSec = s.plannedSec;
		// Only completed, positive intervals log; a reset never reaches here.
		if (durationSec >= 1) {
			const startedAt = s.startedAt;
			const endedAt = startedAt + durationSec * 1000;
			const taskId = kind === "work" ? s.boundTaskId : null;
			void runMutation(
				zero.mutate(
					mutators.focus.logSession({
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
	}, [zero, plannedFor, showCue]);

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
	}, [session?.running, complete]);

	const start = useCallback(() => {
		setSession((prev) => {
			const cfg = configRef.current;
			if (!prev) {
				const sec = plannedFor(INITIAL_CYCLE, cfg);
				const now = Date.now();
				return {
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
				endsAt: now + prev.remainingSec * 1000,
			};
		});
	}, [plannedFor]);

	const pause = useCallback(() => {
		setSession((prev) => {
			if (!prev?.running || prev.endsAt == null) return prev;
			return {
				...prev,
				running: false,
				endsAt: null,
				remainingSec: remainingSecFrom(prev.endsAt, Date.now()),
			};
		});
	}, []);

	// Stop and discard: a mid-interval reset must NOT log a session.
	const reset = useCallback(() => {
		setSession(null);
		setCue(null);
	}, []);

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
					cycle: next,
					plannedSec: sec,
					startedAt: now,
					endsAt: now + sec * 1000,
					remainingSec: sec,
				};
			}
			return {
				...prev,
				cycle: next,
				plannedSec: sec,
				startedAt: null,
				endsAt: null,
				remainingSec: sec,
			};
		});
	}, [plannedFor]);

	const bindTask = useCallback(
		(taskId: string | null, title: string | null) => {
			setSession((prev) =>
				prev ? { ...prev, boundTaskId: taskId, boundTaskTitle: title } : prev,
			);
		},
		[],
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
		[plannedFor],
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
