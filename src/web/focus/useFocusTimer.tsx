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
	type FocusState,
	focusStorageKey,
	intervalFields,
	restoreFocusState,
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

	const [snapshot, setSnapshot] = useState(() => {
		let raw: string | null = null;
		try {
			raw = localStorage.getItem(storageKey);
		} catch (error) {
			console.error("Could not read focus timer", error);
		}
		return { key: storageKey, raw, ...restoreFocusState(raw) };
	});
	const snapshotRef = useRef(snapshot);
	const session = snapshot.key === storageKey ? snapshot.session : null;
	const sessionRef = useRef(session);

	const synchronize = useCallback(() => {
		try {
			const raw = localStorage.getItem(storageKey);
			if (
				snapshotRef.current.key === storageKey &&
				raw === snapshotRef.current.raw
			)
				return true;
			const next = { key: storageKey, raw, ...restoreFocusState(raw) };
			snapshotRef.current = next;
			sessionRef.current = next.session;
			setSnapshot(next);
		} catch (error) {
			console.error("Could not read focus timer", error);
		}
		return false;
	}, [storageKey]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (
				(event.key === storageKey || event.key === null) &&
				(event.storageArea === localStorage || event.storageArea === null)
			)
				synchronize();
		};
		window.addEventListener("storage", onStorage);
		synchronize();
		return () => window.removeEventListener("storage", onStorage);
	}, [storageKey, synchronize]);

	// Fence stale tabs even before their storage event arrives. A completion and
	// its next interval share one write, so reload always retains the log intent.
	const updateFocus = useCallback(
		(update: (state: FocusState) => FocusState) => {
			if (!synchronize()) return false;
			const current = snapshotRef.current;
			const next = update(current);
			if (next === current) return true;
			try {
				const raw =
					next.session || next.pendingCompletions.length
						? serializeFocus(next.session, next.pendingCompletions)
						: null;
				if (raw === null) localStorage.removeItem(storageKey);
				else localStorage.setItem(storageKey, raw);
				const saved = { ...next, key: storageKey, raw };
				snapshotRef.current = saved;
				sessionRef.current = saved.session;
				setSnapshot(saved);
				return true;
			} catch (error) {
				console.error("Could not persist focus timer", error);
				return false;
			}
		},
		[storageKey, synchronize],
	);

	const setSession = useCallback(
		(update: Session | null | ((previous: Session | null) => Session | null)) =>
			updateFocus((current) => {
				const next =
					typeof update === "function" ? update(current.session) : update;
				return next === current.session
					? current
					: { ...current, session: next };
			}),
		[updateFocus],
	);

	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const attemptedRef = useRef(new Set<string>());
	useEffect(() => {
		if (snapshot.key !== storageKey) return;
		for (const completion of snapshot.pendingCompletions) {
			const attempt = `${storageKey}:${completion.intervalId}`;
			if (attemptedRef.current.has(attempt)) continue;
			attemptedRef.current.add(attempt);
			void (async () => {
				try {
					const saved = await runMutation(
						zero.mutate(mutators.focus.logSession(completion)),
						(msg) => console.error("focus.logSession failed", msg),
					);
					if (!saved || !mountedRef.current) return;
					updateFocus((current) => ({
						...current,
						pendingCompletions: current.pendingCompletions.filter(
							(item) => item.intervalId !== completion.intervalId,
						),
					}));
				} catch (error) {
					console.error("focus.logSession failed", error);
				}
			})();
		}
	}, [snapshot, storageKey, zero, updateFocus]);

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
		const startedAt = s.startedAt;

		const next = nextCycle(s.cycle, cfg);
		const nextSec = plannedFor(next, cfg);
		const now = Date.now();
		const advanced = updateFocus((current) => ({
			...current,
			session: {
				...intervalFields(cfg),
				cycle: next,
				plannedSec: nextSec,
				running: cfg.autoCycle,
				startedAt: cfg.autoCycle ? now : null,
				endsAt: cfg.autoCycle ? now + nextSec * 1000 : null,
				remainingSec: nextSec,
				boundTaskId: s.boundTaskId,
				boundTaskTitle: s.boundTaskTitle,
			},
			pendingCompletions: [
				...current.pendingCompletions,
				{
					intervalId: s.intervalId,
					...(kind === "work" && s.boundTaskId
						? { taskId: s.boundTaskId }
						: {}),
					kind,
					startedAt,
					endedAt: s.endsAt ?? startedAt + durationSec * 1000,
					durationSec,
				},
			],
		}));
		if (advanced)
			showCue(
				kind === "work"
					? m.focus_cue_work_complete()
					: m.focus_cue_break_over(),
			);
	}, [plannedFor, showCue, updateFocus]);

	// Tick while running: remaining is recomputed from `endsAt` each tick (not
	// decremented), so a throttled/suspended tab catches up on the next fire.
	// setState only when the whole-second value changes, so the aria-live phase
	// region is not thrashed.
	useEffect(() => {
		if (!session?.running) return;
		function tick() {
			if (!synchronize()) return;
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
	}, [session?.running, complete, setSession, synchronize]);

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
