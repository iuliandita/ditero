import { useQuery, useZero } from "@rocicorp/zero/react";
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
import {
	focusEarlyWaitMs,
	isFocusDuplicate,
} from "../../domain/focus-interval.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
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
	type FocusCompletion,
	type FocusState,
	focusStorageKey,
	intervalFields,
	MAX_PAUSED_MS,
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
// Missing confirmation becomes visible after this delay; it does not discard
// the unresolved shared interval.
const START_LOOKUP_GRACE_MS = 10_000;
const START_ACCEPTANCE_MS = 14 * 86_400_000;

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
		provenMs: number;
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

	const acknowledgedRef = useRef(new Set<string>());
	const announceRef = useRef<(state: FocusState) => void>(() => undefined);
	const updateFocus = useCallback(
		async (update: (state: FocusState) => FocusState) => {
			try {
				let announce = false;
				const { state, changed } = await accessFocusState(
					storageKey,
					(current) => {
						const next = update(current);
						announce = Boolean(
							next.session?.running &&
								(next.session.intervalId !== current.session?.intervalId ||
									!current.session?.running),
						);
						return next;
					},
				);
				applySnapshot(state);
				if (changed) {
					if (announce) announceRef.current(state);
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

	const markServerStarted = useCallback(
		(intervalId: string, serverStarted = true) =>
			updateFocus((current) =>
				current.session?.intervalId === intervalId &&
				current.session.serverStarted !== serverStarted
					? {
							...current,
							session: { ...current.session, serverStarted },
						}
					: current,
			),
		[updateFocus],
	);

	// The server-recorded starts of this account's intervals. They survive a
	// reload (Zero re-sends a queued start), so an interval whose acknowledgement
	// was lost is still known to the server.
	const [startRows, startDetails] = useQuery(
		queries.focusIntervalStarts.mine(),
	);
	const startedIds = useMemo(
		() => new Set(startRows.map((row) => row.intervalId)),
		[startRows],
	);

	const observedIntervalRef = useRef({ intervalId: "", at: performance.now() });
	const storedIntervalId =
		snapshot.key === storageKey ? snapshot.state.session?.intervalId : null;
	if (observedIntervalRef.current.intervalId !== storedIntervalId)
		observedIntervalRef.current = {
			intervalId: storedIntervalId ?? "",
			at: performance.now(),
		};
	const storedServerStarted =
		snapshot.key === storageKey ? snapshot.state.session?.serverStarted : true;
	useEffect(() => {
		if (!storedIntervalId) return;
		if (
			performance.now() - observedIntervalRef.current.at >=
			START_ACCEPTANCE_MS
		)
			return;
		const present =
			startedIds.has(storedIntervalId) ||
			acknowledgedRef.current.has(storedIntervalId);
		if (present && !storedServerStarted)
			void markServerStarted(storedIntervalId);
		else if (
			startDetails.type === "complete" &&
			!present &&
			storedServerStarted
		)
			void markServerStarted(storedIntervalId, false);
	}, [
		storedIntervalId,
		storedServerStarted,
		startedIds,
		startDetails.type,
		markServerStarted,
	]);

	// A fresh interval is announced to the server at once, so its start is
	// observed with the server's clock. Only a server acknowledgement marks the
	// interval as server-started; offline starts keep the monotonic-proof gate.
	const announcedRef = useRef(new Set<string>());
	useEffect(() => {
		announceRef.current = (state) => {
			const s = state.session;
			if (!s?.running || s.serverStarted || s.remainingSec !== s.plannedSec)
				return;
			const key = `${storageKey}:${s.intervalId}`;
			if (announcedRef.current.has(key) || navigator.onLine === false) return;
			announcedRef.current.add(key);
			void (async () => {
				try {
					const mutation = zero.mutate(
						mutators.focus.startInterval({ intervalId: s.intervalId }),
					);
					const failure =
						mutationResultFailure(await mutation.client) ??
						mutationResultFailure(await mutation.server);
					if (failure) return;
					acknowledgedRef.current.add(s.intervalId);
					await markServerStarted(s.intervalId);
				} catch (error) {
					console.error("focus.startInterval failed", error);
				}
			})();
		};
	}, [storageKey, zero, markServerStarted]);

	const setSession = useCallback(
		(update: (previous: Session | null, at: number) => Session | null) => {
			void updateFocus((current) => {
				// Anchor to the serialized action, never a stale display tick.
				const wall = Date.now();
				const monotonic = performance.now();
				const next = update(current.session, wall);
				if (next?.running && current.pendingCompletions.length > 0)
					return current;
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
						provenMs: next.provenMs,
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
	const unresolvedNoticesRef = useRef(new Set<string>());
	const attemptedRef = useRef(new Set<string>());
	const retriesRef = useRef(new Map<string, number>());
	const retryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
	const replayRef = useRef<(completion: FocusCompletion) => void>(
		() => undefined,
	);
	useEffect(
		() => () => {
			for (const id of retryTimersRef.current) clearTimeout(id);
			retryTimersRef.current.clear();
		},
		[],
	);
	useEffect(() => {
		replayRef.current = (completion) => {
			const attempt = `${storageKey}:${completion.intervalId}`;
			if (attemptedRef.current.has(attempt)) return;
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
					// Early on the server clock: keep the intent and retry once the
					// server would accept it. Later page loads replay it as well.
					const wait =
						failure?.kind === "app" ? focusEarlyWaitMs(failure.message) : null;
					if (wait !== null) {
						const tries = (retriesRef.current.get(attempt) ?? 0) + 1;
						retriesRef.current.set(attempt, tries);
						if (tries > 5) return;
						const timer = setTimeout(() => {
							retryTimersRef.current.delete(timer);
							const stillPending = snapshotRef.current.state.pendingCompletions;
							if (
								!stillPending.some(
									(item) => item.intervalId === completion.intervalId,
								)
							)
								return;
							attemptedRef.current.delete(attempt);
							replayRef.current(completion);
						}, Math.max(wait, 1000) + 250);
						retryTimersRef.current.add(timer);
						return;
					}
					// Another tab logged this interval first: the work is recorded.
					const duplicate =
						failure?.kind === "app" && isFocusDuplicate(failure.message);
					if (failure && !duplicate)
						setFailureNotice({
							key: storageKey,
							message: mutationFailureMessage(failure, m.focus_log_failed),
						});
					await updateFocus((current) => {
						const at = Date.now();
						const pendingCompletions = current.pendingCompletions.filter(
							(item) => item.intervalId !== completion.intervalId,
						);
						return pendingCompletions.length ===
							current.pendingCompletions.length
							? current
							: {
									...current,
									pendingCompletions,
									session:
										pendingCompletions.length === 0 &&
										current.session?.waitingForCompletion
											? {
													...current.session,
													waitingForCompletion: false,
													running: true,
													startedAt: at,
													endsAt: at + current.session.plannedSec * 1000,
												}
											: current.session,
								};
					});
				} catch (error) {
					console.error("focus.logSession failed", error);
				}
			})();
		};
	}, [storageKey, zero, updateFocus]);
	useEffect(() => {
		if (snapshot.key !== storageKey) return;
		for (const completion of snapshot.state.pendingCompletions)
			replayRef.current(completion);
	}, [snapshot, storageKey]);

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
				clock.remainingSec !== session.remainingSec ||
				clock.provenMs !== session.provenMs
			) {
				clock = {
					intervalId: session.intervalId,
					endsAt,
					remainingSec: session.remainingSec,
					// Wall time restores only the display. Credit requires elapsed
					// monotonic time observed by a live page, excluding reload gaps.
					wall: Math.max(Date.now(), endsAt - session.remainingSec * 1000),
					monotonic: performance.now(),
					provenMs: session.provenMs,
				};
				clockRef.current = clock;
			}
			return clock.wall + Math.max(0, monotonic - clock.monotonic);
		},
		[],
	);
	const provenTime = useCallback(
		(session: Session) => {
			timerNow(session);
			const clock = clockRef.current;
			return Math.min(
				session.plannedSec * 1000,
				(clock?.provenMs ?? session.provenMs) +
					(clock ? Math.max(0, performance.now() - clock.monotonic) : 0),
			);
		},
		[timerNow],
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

	// A current synced start or this page's live acknowledgement can establish
	// server evidence. The persisted flag alone cannot survive a database restore.
	const countable = useCallback(
		(session: Session) =>
			startedIds.has(session.intervalId) ||
			acknowledgedRef.current.has(session.intervalId) ||
			provenTime(session) >= session.plannedSec * 1000,
		[provenTime, startedIds],
	);
	const completingRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			!storedSession?.running ||
			storedSession.endsAt === null ||
			timerNow(storedSession, now) < storedSession.endsAt ||
			completingRef.current === storedSession.intervalId
		)
			return;
		// A timeout is not evidence of absence. Keep the shared interval intact:
		// another live observer may have proof, or the start may sync later.
		if (!countable(storedSession)) {
			if (
				now - observedIntervalRef.current.at >= START_LOOKUP_GRACE_MS &&
				storedSession.cycle.phase === "work" &&
				!unresolvedNoticesRef.current.has(
					`${storageKey}:${storedSession.intervalId}`,
				)
			) {
				unresolvedNoticesRef.current.add(
					`${storageKey}:${storedSession.intervalId}`,
				);
				setFailureNotice({ key: storageKey, message: m.focus_not_counted() });
			}
			return;
		}
		const intervalId = storedSession.intervalId;
		completingRef.current = intervalId;
		let kind: "work" | "break" | null = null;
		let counted = true;
		void updateFocus((current) => {
			const s = current.session;
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
			const monotonicProof = provenTime(s) >= s.plannedSec * 1000;
			const credit = countable(s);
			if (!credit) return current;
			counted = credit;
			const fields = intervalFields(cfg);

			return {
				...current,
				session: {
					...s,
					...fields,
					cycle,
					plannedSec: sec,
					running: false,
					waitingForCompletion: cfg.autoCycle,
					startedAt: null,
					endsAt: null,
					remainingSec: sec,
				},
				pendingCompletions: credit
					? [
							...current.pendingCompletions,
							{
								intervalId,
								proof: monotonicProof
									? ("monotonic" as const)
									: ("server" as const),
								...(kind === "work" && s.boundTaskId
									? { taskId: s.boundTaskId }
									: {}),
								kind,
								// Pauses and clock corrections must not shorten the logged span.
								startedAt: s.endsAt - s.plannedSec * 1000,
								endedAt: s.endsAt,
								durationSec: s.plannedSec,
								...(s.pausedMs > 0 ? { pausedMs: Math.round(s.pausedMs) } : {}),
							},
						]
					: current.pendingCompletions,
			};
		}).then((changed) => {
			completingRef.current = null;
			if (changed && mountedRef.current && keyRef.current === storageKey) {
				if (counted)
					setFailureNotice((notice) =>
						notice?.message === m.focus_not_counted() ? null : notice,
					);
				cueIdRef.current += 1;
				setCue({
					id: cueIdRef.current,
					text:
						kind === "work"
							? m.focus_cue_work_complete()
							: m.focus_cue_break_over(),
				});
				if (!counted && kind === "work")
					setFailureNotice({ key: storageKey, message: m.focus_not_counted() });
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
		countable,
		provenTime,
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
					// Wall time since the pause, measured against the virtual start.
					pausedMs: Math.min(
						MAX_PAUSED_MS,
						previous.pausedMs +
							(previous.startedAt === null
								? 0
								: Math.max(
										0,
										at -
											(previous.startedAt +
												(previous.plannedSec - previous.remainingSec) * 1000),
									)),
					),
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
			if (previous?.waitingForCompletion)
				return { ...previous, waitingForCompletion: false };
			if (!previous?.running || previous.endsAt === null) return previous;
			return {
				...previous,
				running: false,
				endsAt: null,
				remainingSec: remainingSecFrom(previous.endsAt, timerNow(previous)),
				provenMs: provenTime(previous),
			};
		});
	}, [setSession, timerNow, provenTime]);

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
