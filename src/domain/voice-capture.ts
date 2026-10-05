export const VOICE_MAX_ALTERNATIVES = 3;
export const VOICE_MAX_TRANSCRIPT_CHARS = 500;
// Hard cap from start() until a final result, covering check, listen and stop.
export const VOICE_CAPTURE_TIMEOUT_MS = 20_000;

// Explicit, closed mapping. Unknown locales are NOT mapped to English.
const VOICE_LOCALE_TAGS: Readonly<Record<string, string>> = {
	en: "en-US",
	de: "de-DE",
	es: "es-ES",
	fr: "fr-FR",
	ro: "ro-RO",
	ar: "ar-SA",
};

export function voiceLocaleTag(locale: unknown): string | null {
	if (typeof locale !== "string") return null;
	return Object.hasOwn(VOICE_LOCALE_TAGS, locale)
		? VOICE_LOCALE_TAGS[locale]
		: null;
}

// Identifiers only. The UI translates these; nothing here is user-facing prose.
export const VOICE_REASONS = [
	// Permanent or environment-level: the phase is `unsupported`.
	"unsupported-native",
	"unsupported-locale",
	"unsupported-insecure-context",
	"unsupported-no-api",
	"unsupported-no-local-processing",
	"language-pack-unavailable",
	// Everything below lands in the `error` phase.
	"language-pack-downloadable",
	"language-pack-downloading",
	"availability-check-failed",
	"local-processing-not-enforced",
	"locale-not-applied",
	"start-failed",
	"permission-denied",
	"audio-capture",
	"no-speech",
	"no-match",
	"engine-error",
	"ended-without-result",
	"timeout",
	"result-invalid",
	"result-empty",
	"result-too-long",
	"result-too-many-alternatives",
] as const;

export type VoiceReason = (typeof VOICE_REASONS)[number];

const UNSUPPORTED_REASONS: ReadonlySet<string> = new Set(
	VOICE_REASONS.slice(0, 6),
);

export function isVoiceReason(value: unknown): value is VoiceReason {
	return (
		typeof value === "string" &&
		(VOICE_REASONS as readonly string[]).includes(value)
	);
}

export type VoicePhase =
	| "idle"
	| "checking"
	| "listening"
	| "stopping"
	| "review"
	| "error"
	| "unsupported";

export type VoiceState =
	| { phase: "idle"; session: number; ready: boolean }
	| { phase: "checking" | "listening" | "stopping"; session: number }
	| { phase: "review"; session: number; alternatives: readonly string[] }
	| { phase: "error" | "unsupported"; session: number; reason: VoiceReason };

export type VoiceInvalidation =
	| "account"
	| "workspace"
	| "list"
	| "locale"
	| "page";

// --- engine port -----------------------------------------------------------

export type VoiceCapability =
	| { status: "available" }
	| { status: "refused"; reason: VoiceReason };

export type VoiceEngineEvent =
	// A FINAL result. `alternatives` is untrusted and validated by the domain.
	| { type: "result"; alternatives: unknown }
	| { type: "error"; reason: VoiceReason }
	| { type: "end" };

export interface VoiceEngineSession {
	/** Ask for the final result of what was heard so far. */
	stop(): void;
	/** Discard everything and detach handlers. Idempotent, must not throw. */
	abort(): void;
}

export interface VoiceEngine {
	/** Capability probe only. Must not start listening. */
	check(tag: string): Promise<VoiceCapability>;
	/** Start listening. Throws (ideally VoiceEngineError) if it cannot. */
	start(
		tag: string,
		onEvent: (event: VoiceEngineEvent) => void,
	): VoiceEngineSession;
}

export class VoiceEngineError extends Error {
	readonly reason: VoiceReason;
	constructor(reason: VoiceReason) {
		super(reason);
		this.name = "VoiceEngineError";
		this.reason = reason;
	}
}

// --- pure helpers ----------------------------------------------------------

export type VoiceNormalization =
	| { ok: true; alternatives: string[] }
	| { ok: false; reason: VoiceReason };

/**
 * Validate untrusted final alternatives. Trims, drops blanks, de-duplicates
 * exact repeats. Never truncates: anything over the bounds is rejected.
 */
export function normalizeVoiceAlternatives(raw: unknown): VoiceNormalization {
	if (!Array.isArray(raw)) return { ok: false, reason: "result-invalid" };
	if (raw.length > VOICE_MAX_ALTERNATIVES) {
		return { ok: false, reason: "result-too-many-alternatives" };
	}
	const seen = new Set<string>();
	const alternatives: string[] = [];
	for (const item of raw as unknown[]) {
		if (typeof item !== "string")
			return { ok: false, reason: "result-invalid" };
		const text = item.trim();
		if (text === "") continue;
		if ([...text].length > VOICE_MAX_TRANSCRIPT_CHARS) {
			return { ok: false, reason: "result-too-long" };
		}
		if (!seen.has(text)) {
			seen.add(text);
			alternatives.push(text);
		}
	}
	if (alternatives.length === 0) return { ok: false, reason: "result-empty" };
	return { ok: true, alternatives };
}

/** Append accepted text to an existing draft with exactly one separator. */
export function appendVoiceDraft(draft: string, accepted: string): string {
	if (draft === "") return accepted;
	return /\s$/u.test(draft) ? draft + accepted : `${draft} ${accepted}`;
}

// --- controller ------------------------------------------------------------

export interface VoiceTimers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: VoiceTimers = {
	setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
	clearTimeout: (handle) =>
		globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface VoiceCaptureOptions {
	engine: VoiceEngine;
	/** `"NativeDitero" in globalThis`: Android AND desktop shells. */
	native: boolean;
	/** App locale code (en/de/es/fr/ro/ar). Fixed for this controller. */
	locale: string;
	timers?: VoiceTimers;
	timeoutMs?: number;
}

export interface VoiceCapture {
	getState(): VoiceState;
	subscribe(listener: () => void): () => void;
	/** Capability check only; ends in idle{ready} or error/unsupported. */
	probe(): void;
	/**
	 * Begin capture. Call from the user's gesture handler. After a successful
	 * `probe()` the engine starts synchronously inside the gesture; otherwise
	 * the probe runs first and start follows when it resolves.
	 */
	start(): void;
	/** Ask for the final result; stays in `stopping` until it arrives. */
	stop(): void;
	/** Abort and discard any transcript. Returns to idle. */
	cancel(): void;
	/** Same as cancel; for account/workspace/list/locale/page transitions. */
	invalidate(cause: VoiceInvalidation): void;
	/**
	 * Explicit acceptance of a reviewed alternative. Returns the draft with the
	 * text appended (editable, no task mutation) or null when nothing is in
	 * review. Cancel/failure never touch the draft.
	 */
	accept(draft: string, index?: number): string | null;
	/** Cancel, drop listeners, ignore all later calls and callbacks. */
	dispose(): void;
}

export function createVoiceCapture(options: VoiceCaptureOptions): VoiceCapture {
	const { engine } = options;
	const timers = options.timers ?? defaultTimers;
	const timeoutMs =
		typeof options.timeoutMs === "number" &&
		Number.isFinite(options.timeoutMs) &&
		options.timeoutMs > 0
			? options.timeoutMs
			: VOICE_CAPTURE_TIMEOUT_MS;
	const tag = voiceLocaleTag(options.locale);
	const langTag = tag ?? "";
	const permanent: VoiceReason | null = options.native
		? "unsupported-native"
		: tag === null
			? "unsupported-locale"
			: null;

	let session = 0;
	let disposed = false;
	let ready = false;
	let timer: unknown = null;
	let active: VoiceEngineSession | null = null;
	const listeners = new Set<() => void>();
	let state: VoiceState = permanent
		? { phase: "unsupported", session, reason: permanent }
		: { phase: "idle", session, ready };

	const set = (next: VoiceState) => {
		state = next;
		for (const listener of [...listeners]) listener();
	};

	const clearTimer = () => {
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
	};

	const release = () => {
		clearTimer();
		const current = active;
		active = null;
		if (current) abortQuietly(current);
	};

	// Invalidate every outstanding callback, then drop live resources.
	const fence = () => {
		session += 1;
		release();
		return session;
	};

	// Failing fences too, so a late check/engine callback cannot revive the
	// session after a timeout or error.
	const fail = (reason: VoiceReason) => {
		fence();
		ready = false;
		set({
			phase: UNSUPPORTED_REASONS.has(reason) ? "unsupported" : "error",
			session,
			reason,
		});
	};

	const armTimer = (token: number) => {
		timer = timers.setTimeout(() => {
			if (token !== session) return;
			timer = null;
			fail("timeout");
		}, timeoutMs);
	};

	const busy = () =>
		state.phase === "checking" ||
		state.phase === "listening" ||
		state.phase === "stopping";

	// Reads `state` fresh: a listener may have replaced it during set().
	const live = (token: number, phase: VoicePhase) =>
		token === session && !disposed && state.phase === phase;

	const onEvent = (token: number, event: VoiceEngineEvent) => {
		if (token !== session) return;
		if (state.phase !== "listening" && state.phase !== "stopping") return;
		const raw: unknown = event;
		const type =
			typeof raw === "object" && raw !== null
				? (raw as { type?: unknown }).type
				: undefined;
		if (type === "result") {
			const result = normalizeVoiceAlternatives(
				(raw as { alternatives?: unknown }).alternatives,
			);
			if (!result.ok) return fail(result.reason);
			release();
			set({
				phase: "review",
				session: token,
				alternatives: result.alternatives,
			});
		} else if (type === "error") {
			const reason = (raw as { reason?: unknown }).reason;
			fail(isVoiceReason(reason) ? reason : "engine-error");
		} else if (type === "end") {
			fail("ended-without-result");
		} else {
			fail("engine-error");
		}
	};

	const listen = (token: number) => {
		set({ phase: "listening", session: token });
		if (token !== session || disposed || state.phase !== "listening") return;
		let created: VoiceEngineSession;
		try {
			created = engine.start(langTag, (event) => onEvent(token, event));
		} catch (error) {
			if (token === session) {
				fail(error instanceof VoiceEngineError ? error.reason : "start-failed");
			}
			return;
		}
		// An event during start() may already have ended this session.
		if (token !== session || state.phase !== "listening") {
			abortQuietly(created);
			return;
		}
		active = created;
	};

	const runCheck = (token: number, onAvailable: () => void) => {
		let pending: Promise<VoiceCapability>;
		try {
			pending = Promise.resolve(engine.check(langTag));
		} catch {
			pending = Promise.reject(new Error("check threw"));
		}
		void pending.then(
			(capability) => {
				if (token !== session) return;
				const raw: unknown = capability;
				const status =
					typeof raw === "object" && raw !== null
						? (raw as { status?: unknown }).status
						: undefined;
				if (status === "available") {
					ready = true;
					onAvailable();
				} else if (status === "refused") {
					const reason = (raw as { reason?: unknown }).reason;
					fail(isVoiceReason(reason) ? reason : "availability-check-failed");
				} else {
					fail("availability-check-failed");
				}
			},
			() => {
				if (token === session) fail("availability-check-failed");
			},
		);
	};

	const cancel = () => {
		if (disposed) return;
		fence();
		if (permanent) return;
		if (state.phase !== "idle") set({ phase: "idle", session, ready });
	};

	return {
		getState: () => state,
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		probe() {
			if (disposed || permanent || busy() || ready) return;
			const token = fence();
			set({ phase: "checking", session: token });
			if (!live(token, "checking")) return;
			armTimer(token);
			runCheck(token, () => {
				clearTimer();
				set({ phase: "idle", session: token, ready: true });
			});
		},
		start() {
			if (disposed || permanent || busy()) return;
			const token = fence();
			armTimer(token);
			if (ready) {
				listen(token);
				return;
			}
			set({ phase: "checking", session: token });
			if (!live(token, "checking")) return;
			runCheck(token, () => listen(token));
		},
		stop() {
			if (disposed || state.phase !== "listening") return;
			const token = session;
			const current = active;
			set({ phase: "stopping", session: token });
			if (!live(token, "stopping")) return;
			try {
				current?.stop();
			} catch {
				if (live(token, "stopping")) fail("engine-error");
			}
		},
		cancel,
		invalidate(_cause) {
			cancel();
		},
		accept(draft, index = 0) {
			if (disposed || state.phase !== "review") return null;
			const picked = state.alternatives[index];
			if (picked === undefined) return null;
			fence();
			set({ phase: "idle", session, ready });
			return appendVoiceDraft(typeof draft === "string" ? draft : "", picked);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			fence();
			listeners.clear();
			if (!permanent) state = { phase: "idle", session, ready };
		},
	};
}

function abortQuietly(handle: VoiceEngineSession) {
	try {
		handle.abort();
	} catch {
		// abort() is best-effort cleanup; nothing to report.
	}
}
