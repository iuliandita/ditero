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
import {
	mutationFailureMessage,
	mutationResultFailure,
} from "../lib/run-mutation.ts";
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
	accessFocusState,
	emptyFocusState,
	type FocusState,
	focusStorageKey,
	intervalFields,
	type FocusSessionState as Session,
} from "./timer-persistence.ts";

type Cue = { id: number; text: string };

export type FocusTimerApi = {
	session: Session | null;
	config: FocusConfig;
	roundsPerLongBreak: number;
	cue: Cue | null;
	error: string | null;
	dismissError: () => void;
	start: () => void;
	pause: () => void;
	reset: () => void;
	skip: () => void;
	bindTask: (taskId: string | null, title: string | null) => void;
	startForTask: (taskId: string, title: string) => void;
};

const FocusContext = createContext<FocusTimerApi | null>(null);
const CUE_MS = 5000;

// Production builds omit the short-interval browser-test seam.
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
	const native = useNativeAccount();
	const storageKey = focusStorageKey(userId, native?.storageScope);
	const { pref, loading } = useUserPref();
	const config = useMemo(() => clampFocusConfig(pref.focus), [pref.focus]);
	const prefRef = useRef({ config, loading });
	prefRef.current = { config, loading };
	const [snapshot, setSnapshot] = useState(() => ({
		key: storageKey,
		state: emptyFocusState(),
	}));
	const snapshotRef = useRef(snapshot);
	const keyRef = useRef(storageKey);
	keyRef.current = storageKey;
	const mountedRef = useRef(false);
	const clockRef = useRef<{
		intervalId: string;
		endsAt: number;
		remainingSec: number;
		wall: number;
		monotonic: number;
	} | null>(null);

	const applySnapshot = useCallback(
		(state: FocusState) => {
			if (!mountedRef.current || keyRef.current !== storageKey) return;
			const current = snapshotRef.current;
			if (
				current.key === storageKey &&
				current.state.revision >= state.revision
			)
				return;
			const next = { key: storageKey, state };
			snapshotRef.current = next;
			setSnapshot(next);
		},
		[storageKey],
	);

	const synchronize = useCallback(async () => {
		try {
			applySnapshot((await accessFocusState(storageKey)).state);
		} catch (error) {
			console.error("Could not read focus timer", error);
		}
	}, [applySnapshot, storageKey]);

	useEffect(() => {
		mountedRef.current = true;
		const onStorage = (event: StorageEvent) => {
			if (
				(event.key === storageKey || event.key === null) &&
				(event.storageArea === localStorage || event.storageArea === null)
			)
				void synchronize();
		};
		window.addEventListener("storage", onStorage);
		window.addEventListener("focus", synchronize);
		void synchronize();
		return () => {
			mountedRef.current = false;
			window.removeEventListener("storage", onStorage);
			window.removeEventListener("focus", synchronize);
		};
	}, [storageKey, synchronize]);

	const updateFocus = useCallback(
		async (update: (state: FocusState) => FocusState) => {
			try {
				const { state, changed } = await accessFocusState(storageKey, update);
				applySnapshot(state);
				if (changed) {
					try {
						localStorage.setItem(storageKey, String(state.revision));
					} catch (error) {
						console.error("Could not notify other focus timers", error);
					}
				}
				return changed;
			} catch (error) {
				console.error("Could not persist focus timer", error);
				return false;
			}
		},
		[storageKey, applySnapshot],
	);

	const setSession = useCallback(
		(update: (previous: Session | null, at: number) => Session | null) => {
			// Anchor the action itself, never the last rendered display tick.
			const wall = Date.now();
			const monotonic = performance.now();
			void updateFocus((current) => {
				const next = update(current.session, wall);
				if (
					next?.running &&
					next.endsAt !== null &&
					(next.intervalId !== current.session?.intervalId ||
						next.endsAt !== current.session?.endsAt ||
						!current.session?.running)
				) {
					clockRef.current = {
						intervalId: next.intervalId,
						endsAt: next.endsAt,
						remainingSec: next.remainingSec,
						wall,
						monotonic,
					};
				}
				return next === current.session
					? current
					: { ...current, session: next };
			});
		},
		[updateFocus],
	);

	const [failureNotice, setFailureNotice] = useState<{
		key: string;
		message: string;
	} | null>(null);
	const error =
		failureNotice?.key === storageKey ? failureNotice.message : null;
	const dismissError = useCallback(() => setFailureNotice(null), []);
	const attemptedRef = useRef(new Set<string>());
	useEffect(() => {
		if (snapshot.key !== storageKey) return;
		for (const completion of snapshot.state.pendingCompletions) {
			const attempt = `${storageKey}:${completion.intervalId}`;
			if (attemptedRef.current.has(attempt)) continue;
			attemptedRef.current.add(attempt);
			void (async () => {
				try {
					const mutation = zero.mutate(mutators.focus.logSession(completion));
					const localFailure = mutationResultFailure(await mutation.client);
					// A local commit can still be waiting for idle disk persistence.
					// Keep the replay intent until the server has settled the write.
					const failure =
						localFailure ?? mutationResultFailure(await mutation.server);
					if (!mountedRef.current || keyRef.current !== storageKey) return;
					if (failure?.kind === "zero") return;
					if (failure)
						setFailureNotice({
							key: storageKey,
							message: mutationFailureMessage(failure, m.focus_log_failed),
						});
					await updateFocus((current) => {
						const pendingCompletions = current.pendingCompletions.filter(
							(item) => item.intervalId !== completion.intervalId,
						);
						return pendingCompletions.length ===
							current.pendingCompletions.length
							? current
							: { ...current, pendingCompletions };
					});
				} catch (error) {
					console.error("focus.logSession failed", error);
				}
			})();
		}
	}, [snapshot, storageKey, zero, updateFocus]);

	const [cue, setCue] = useState<Cue | null>(null);
	const cueIdRef = useRef(0);
	useEffect(() => {
		if (!cue) return;
		const id = setTimeout(() => {
			setCue((current) => (current?.id === cue.id ? null : current));
		}, CUE_MS);
		return () => clearTimeout(id);
	}, [cue]);

	const plannedFor = useCallback((cycle: Cycle, cfg: FocusConfig): number => {
		return testOverrideSec() ?? phaseDurationSec(cycle, cfg);
	}, []);
	const configFor = useCallback((previous: Session | null) => {
		return prefRef.current.loading && previous
			? previous.config
			: prefRef.current.config;
	}, []);

	const storedSession =
		snapshot.key === storageKey ? snapshot.state.session : null;
	const timerNow = useCallback(
		(session: Session, monotonic = performance.now()) => {
			const endsAt = session.endsAt;
			if (endsAt === null) return Date.now();
			let clock = clockRef.current;
			if (
				clock?.intervalId !== session.intervalId ||
				clock.endsAt !== endsAt ||
				clock.remainingSec !== session.remainingSec
			) {
				clock = {
					intervalId: session.intervalId,
					endsAt,
					remainingSec: session.remainingSec,
					// Reload has only wall time: forward corrections can credit
					// unworked time up to this interval's length. Backward
					// corrections cannot extend it past its remaining duration.
					wall: Math.max(Date.now(), endsAt - session.remainingSec * 1000),
					monotonic: performance.now(),
				};
				clockRef.current = clock;
			}
			return clock.wall + Math.max(0, monotonic - clock.monotonic);
		},
		[],
	);
	const [now, setNow] = useState(() => performance.now());
	// Ticks change only the display clock. No persistence or session snapshots.
	useEffect(() => {
		if (!storedSession?.running) {
			clockRef.current = null;
			return;
		}
		setNow(performance.now());
		const id = setInterval(() => setNow(performance.now()), 250);
		return () => clearInterval(id);
	}, [storedSession?.running]);

	const completingRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			!storedSession?.running ||
			storedSession.endsAt === null ||
			timerNow(storedSession, now) < storedSession.endsAt ||
			completingRef.current === storedSession.intervalId
		)
			return;
		const intervalId = storedSession.intervalId;
		completingRef.current = intervalId;
		let kind: "work" | "break" | null = null;
		void updateFocus((current) => {
			const s = current.session;
			const at = Date.now();
			if (
				!s?.running ||
				s.intervalId !== intervalId ||
				s.startedAt === null ||
				s.endsAt === null ||
				timerNow(s) < s.endsAt
			)
				return current;
			const cfg = configFor(s);
			const cycle = nextCycle(s.cycle, cfg);
			const sec = plannedFor(cycle, cfg);
			kind = s.cycle.phase;
			return {
				...current,
				session: {
					...s,
					...intervalFields(cfg),
					cycle,
					plannedSec: sec,
					running: cfg.autoCycle,
					startedAt: cfg.autoCycle ? at : null,
					endsAt: cfg.autoCycle ? at + sec * 1000 : null,
					remainingSec: sec,
				},
				pendingCompletions: [
					...current.pendingCompletions,
					{
						intervalId,
						...(kind === "work" && s.boundTaskId
							? { taskId: s.boundTaskId }
							: {}),
						kind,
						// Pauses and clock corrections must not shorten the logged span.
						startedAt: s.endsAt - s.plannedSec * 1000,
						endedAt: s.endsAt,
						durationSec: s.plannedSec,
					},
				],
			};
		}).then((changed) => {
			completingRef.current = null;
			if (changed && mountedRef.current && keyRef.current === storageKey) {
				cueIdRef.current += 1;
				setCue({
					id: cueIdRef.current,
					text:
						kind === "work"
							? m.focus_cue_work_complete()
							: m.focus_cue_break_over(),
				});
			}
		});
	}, [
		storedSession,
		now,
		updateFocus,
		configFor,
		plannedFor,
		storageKey,
		timerNow,
	]);

	const start = useCallback(() => {
		setSession((previous, at) => {
			if (previous?.running) return previous;
			const cfg = configFor(previous);
			if (previous)
				return {
					...previous,
					config: cfg,
					running: true,
					startedAt: at + (previous.remainingSec - previous.plannedSec) * 1000,
					endsAt: at + previous.remainingSec * 1000,
				};
			const sec = plannedFor(INITIAL_CYCLE, cfg);
			return {
				...intervalFields(cfg),
				cycle: INITIAL_CYCLE,
				plannedSec: sec,
				running: true,
				startedAt: at,
				endsAt: at + sec * 1000,
				remainingSec: sec,
				boundTaskId: null,
				boundTaskTitle: null,
			};
		});
	}, [configFor, plannedFor, setSession]);

	const pause = useCallback(() => {
		setSession((previous) => {
			if (!previous?.running || previous.endsAt === null) return previous;
			return {
				...previous,
				running: false,
				endsAt: null,
				remainingSec: remainingSecFrom(previous.endsAt, timerNow(previous)),
			};
		});
	}, [setSession, timerNow]);

	const reset = useCallback(() => {
		setSession(() => null);
		setCue(null);
	}, [setSession]);

	const skip = useCallback(() => {
		setSession((previous, at) => {
			if (!previous) return previous;
			const cfg = configFor(previous);
			const cycle = nextCycle(previous.cycle, cfg);
			const sec = plannedFor(cycle, cfg);
			return {
				...previous,
				...intervalFields(cfg),
				cycle,
				plannedSec: sec,
				startedAt: previous.running ? at : null,
				endsAt: previous.running ? at + sec * 1000 : null,
				remainingSec: sec,
			};
		});
	}, [configFor, plannedFor, setSession]);

	const bindTask = useCallback(
		(taskId: string | null, title: string | null) => {
			setSession((previous) =>
				previous
					? { ...previous, boundTaskId: taskId, boundTaskTitle: title }
					: previous,
			);
		},
		[setSession],
	);

	const startForTask = useCallback(
		(taskId: string, title: string) => {
			setSession((previous, at) => {
				if (previous?.running)
					return { ...previous, boundTaskId: taskId, boundTaskTitle: title };
				const cfg = configFor(previous);
				const sec = plannedFor(INITIAL_CYCLE, cfg);
				return {
					...intervalFields(cfg),
					cycle: INITIAL_CYCLE,
					plannedSec: sec,
					running: true,
					startedAt: at,
					endsAt: at + sec * 1000,
					remainingSec: sec,
					boundTaskId: taskId,
					boundTaskTitle: title,
				};
			});
		},
		[configFor, plannedFor, setSession],
	);

	const session = useMemo(
		() =>
			storedSession
				? {
						...storedSession,
						remainingSec:
							storedSession.running && storedSession.endsAt !== null
								? remainingSecFrom(
										storedSession.endsAt,
										timerNow(storedSession, now),
									)
								: storedSession.remainingSec,
					}
				: null,
		[storedSession, now, timerNow],
	);
	const api = useMemo<FocusTimerApi>(
		() => ({
			session,
			config,
			roundsPerLongBreak: config.roundsPerLongBreak,
			cue,
			error,
			dismissError,
			start,
			pause,
			reset,
			skip,
			bindTask,
			startForTask,
		}),
		[
			session,
			config,
			cue,
			error,
			dismissError,
			start,
			pause,
			reset,
			skip,
			bindTask,
			startForTask,
		],
	);
	return <FocusContext.Provider value={api}>{children}</FocusContext.Provider>;
}

export function useFocusTimer(): FocusTimerApi {
	const ctx = useContext(FocusContext);
	if (!ctx) throw new Error("useFocusTimer used outside FocusProvider");
	return ctx;
}
