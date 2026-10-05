import { describe, expect, test } from "vitest";
import {
	appendVoiceDraft,
	createVoiceCapture,
	isVoiceReason,
	normalizeVoiceAlternatives,
	VOICE_CAPTURE_TIMEOUT_MS,
	type VoiceCapability,
	type VoiceCapture,
	type VoiceEngine,
	VoiceEngineError,
	type VoiceEngineEvent,
	type VoiceTimers,
	voiceLocaleTag,
} from "./voice-capture.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeTimers() {
	let next = 0;
	const pending = new Map<number, { fn: () => void; ms: number }>();
	const timers: VoiceTimers = {
		setTimeout(fn, ms) {
			pending.set(++next, { fn, ms });
			return next;
		},
		clearTimeout(handle) {
			pending.delete(handle as number);
		},
	};
	return {
		timers,
		get size() {
			return pending.size;
		},
		get delays() {
			return [...pending.values()].map((t) => t.ms);
		},
		fireAll() {
			for (const [id, t] of [...pending]) {
				pending.delete(id);
				t.fn();
			}
		},
	};
}

type Started = {
	tag: string;
	emit: (event: VoiceEngineEvent) => void;
	stops: number;
	aborts: number;
};

function fakeEngine(
	opts: {
		startThrows?: unknown;
		syncEvent?: VoiceEngineEvent;
		onStop?: (rec: Started) => void;
	} = {},
) {
	const checks: {
		tag: string;
		resolve: (c: VoiceCapability) => void;
		reject: () => void;
	}[] = [];
	const starts: Started[] = [];
	const engine: VoiceEngine = {
		check(tag) {
			return new Promise<VoiceCapability>((resolve, reject) => {
				checks.push({ tag, resolve, reject: () => reject(new Error("boom")) });
			});
		},
		start(tag, emit) {
			if (opts.startThrows !== undefined) throw opts.startThrows;
			const rec: Started = { tag, emit, stops: 0, aborts: 0 };
			starts.push(rec);
			if (opts.syncEvent) emit(opts.syncEvent);
			return {
				stop() {
					rec.stops++;
					opts.onStop?.(rec);
				},
				abort() {
					rec.aborts++;
				},
			};
		},
	};
	return { engine, checks, starts };
}

const AVAILABLE: VoiceCapability = { status: "available" };
const result = (...alternatives: unknown[]): VoiceEngineEvent => ({
	type: "result",
	alternatives,
});

function setup(
	over: {
		locale?: string;
		native?: boolean;
		engine?: ReturnType<typeof fakeEngine>;
		timeoutMs?: number;
	} = {},
) {
	const fe = over.engine ?? fakeEngine();
	const clock = fakeTimers();
	const capture = createVoiceCapture({
		engine: fe.engine,
		native: over.native ?? false,
		locale: over.locale ?? "en",
		timers: clock.timers,
		timeoutMs: over.timeoutMs,
	});
	return { ...fe, clock, capture };
}

// Drives a fresh controller through the positive path up to `listening`.
async function listening(over: Parameters<typeof setup>[0] = {}) {
	const s = setup(over);
	s.capture.start();
	expect(s.capture.getState().phase).toBe("checking");
	s.checks[0].resolve(AVAILABLE);
	await flush();
	expect(s.capture.getState().phase).toBe("listening");
	expect(s.starts).toHaveLength(1);
	return s;
}

describe("locale mapping", () => {
	test.each([
		["en", "en-US"],
		["de", "de-DE"],
		["es", "es-ES"],
		["fr", "fr-FR"],
		["ro", "ro-RO"],
		["ar", "ar-SA"],
	])("%s maps to %s", (locale, tag) => {
		expect(voiceLocaleTag(locale)).toBe(tag);
	});

	test.each([
		"pt",
		"en-US",
		"",
		"constructor",
		"__proto__",
		"toString",
		"hasOwnProperty",
	])("unknown or prototype locale %j is unsupported, not English", (locale) => {
		expect(voiceLocaleTag(locale)).toBeNull();
	});

	test("non-string locale fails closed", () => {
		expect(voiceLocaleTag(undefined)).toBeNull();
		expect(voiceLocaleTag(5)).toBeNull();
	});

	test.each([
		"en",
		"de",
		"es",
		"fr",
		"ro",
		"ar",
	])("%s capture starts with exactly its own tag, never English", async (locale) => {
		const s = await listening({ locale });
		expect(s.checks[0].tag).toBe(voiceLocaleTag(locale));
		expect(s.starts[0].tag).toBe(voiceLocaleTag(locale));
	});

	test("unmapped locale never reaches the engine", () => {
		const s = setup({ locale: "constructor" });
		expect(s.capture.getState()).toMatchObject({
			phase: "unsupported",
			reason: "unsupported-locale",
		});
		s.capture.start();
		s.capture.probe();
		expect(s.checks).toHaveLength(0);
		expect(s.starts).toHaveLength(0);
	});
});

describe("alternatives bounds", () => {
	test("trims, drops blanks and de-duplicates", () => {
		expect(
			normalizeVoiceAlternatives(["  buy milk ", "buy milk", "buy mil"]),
		).toEqual({
			ok: true,
			alternatives: ["buy milk", "buy mil"],
		});
	});

	test("drops blank alternatives", () => {
		expect(normalizeVoiceAlternatives(["", "   ", "buy milk"])).toEqual({
			ok: true,
			alternatives: ["buy milk"],
		});
	});

	test("accepts exactly 500 characters and keeps them whole", () => {
		const text = "a".repeat(500);
		expect(normalizeVoiceAlternatives([text])).toEqual({
			ok: true,
			alternatives: [text],
		});
	});

	test("rejects 501 characters instead of truncating", () => {
		expect(normalizeVoiceAlternatives(["a".repeat(501)])).toEqual({
			ok: false,
			reason: "result-too-long",
		});
	});

	test("rejects more than three alternatives", () => {
		expect(normalizeVoiceAlternatives(["a", "b", "c", "d"])).toEqual({
			ok: false,
			reason: "result-too-many-alternatives",
		});
	});

	test.each(
		[undefined, null, "text", { 0: "a" }, [1], [null], ["a", {}]].map((raw) => [
			raw,
		]),
	)("unknown shape %j fails closed", (raw) => {
		expect(normalizeVoiceAlternatives(raw)).toEqual({
			ok: false,
			reason: "result-invalid",
		});
	});

	test("all-blank result is empty", () => {
		expect(normalizeVoiceAlternatives([" ", ""])).toEqual({
			ok: false,
			reason: "result-empty",
		});
	});

	test("reason identifiers are recognised and arbitrary text is not", () => {
		expect(isVoiceReason("timeout")).toBe(true);
		expect(isVoiceReason("Microphone blocked")).toBe(false);
		expect(isVoiceReason(undefined)).toBe(false);
	});
});

describe("appendVoiceDraft", () => {
	test("uses a single separator", () => {
		expect(appendVoiceDraft("", "milk")).toBe("milk");
		expect(appendVoiceDraft("buy", "milk")).toBe("buy milk");
		expect(appendVoiceDraft("buy ", "milk")).toBe("buy milk");
		expect(appendVoiceDraft("buy\n", "milk")).toBe("buy\nmilk");
	});
});

describe("native runtime", () => {
	test("is unsupported-native and never touches the engine", () => {
		const s = setup({ native: true });
		expect(s.capture.getState()).toMatchObject({
			phase: "unsupported",
			reason: "unsupported-native",
		});
		s.capture.probe();
		s.capture.start();
		s.capture.stop();
		expect(s.capture.getState().phase).toBe("unsupported");
		expect(s.checks).toHaveLength(0);
		expect(s.starts).toHaveLength(0);
		expect(s.clock.size).toBe(0);
	});

	test("cancel does not lift native unsupported", () => {
		const s = setup({ native: true });
		s.capture.cancel();
		expect(s.capture.getState().phase).toBe("unsupported");
	});
});

describe("capture lifecycle", () => {
	test("final result reaches review only; accept appends explicitly", async () => {
		const s = await listening({ locale: "de" });
		expect(s.clock.delays).toEqual([VOICE_CAPTURE_TIMEOUT_MS]);
		s.starts[0].emit(result(" Milch kaufen ", "Milch kaufen", "Milch kaufe"));
		expect(s.capture.getState()).toMatchObject({
			phase: "review",
			alternatives: ["Milch kaufen", "Milch kaufe"],
		});
		expect(s.clock.size).toBe(0);
		expect(s.starts[0].aborts).toBe(1);
		expect(s.capture.accept("Einkauf")).toBe("Einkauf Milch kaufen");
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.capture.accept("Einkauf")).toBeNull();
	});

	test("accept can pick another alternative and rejects a bad index", async () => {
		const s = await listening();
		s.starts[0].emit(result("one", "two"));
		expect(s.capture.accept("x", 5)).toBeNull();
		expect(s.capture.accept("x", -1)).toBeNull();
		expect(s.capture.getState().phase).toBe("review");
		expect(s.capture.accept("x ", 1)).toBe("x two");
	});

	test("cancel in review discards the transcript and returns nothing to append", async () => {
		const s = await listening();
		s.starts[0].emit(result("secret words"));
		s.capture.cancel();
		expect(s.capture.getState()).toMatchObject({ phase: "idle" });
		expect(JSON.stringify(s.capture.getState())).not.toContain("secret");
		expect(s.capture.accept("original draft")).toBeNull();
	});

	test("probe makes the next start synchronous inside the gesture", async () => {
		const s = setup();
		s.capture.probe();
		expect(s.capture.getState().phase).toBe("checking");
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.capture.getState()).toMatchObject({ phase: "idle", ready: true });
		expect(s.clock.size).toBe(0);
		s.capture.start();
		expect(s.capture.getState().phase).toBe("listening");
		expect(s.starts).toHaveLength(1);
		expect(s.checks).toHaveLength(1);
	});

	test("an event emitted synchronously during engine start is honoured", async () => {
		const s = setup({ engine: fakeEngine({ syncEvent: result("instant") }) });
		s.capture.probe();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		s.capture.start();
		expect(s.capture.getState()).toMatchObject({
			phase: "review",
			alternatives: ["instant"],
		});
		expect(s.starts[0].aborts).toBe(1);
	});

	test("stop waits for the final result before review", async () => {
		const s = await listening();
		s.capture.stop();
		expect(s.capture.getState().phase).toBe("stopping");
		expect(s.starts[0].stops).toBe(1);
		expect(s.clock.size).toBe(1);
		s.starts[0].emit(result("finished thought"));
		expect(s.capture.getState()).toMatchObject({
			phase: "review",
			alternatives: ["finished thought"],
		});
	});

	test("stop outside listening is ignored", () => {
		const s = setup();
		s.capture.stop();
		expect(s.capture.getState().phase).toBe("idle");
	});

	test("start while busy does not open a second session", async () => {
		const s = await listening();
		s.capture.start();
		expect(s.starts).toHaveLength(1);
		expect(s.checks).toHaveLength(1);
	});

	test("restarting from review discards the earlier transcript", async () => {
		const s = await listening();
		s.starts[0].emit(result("old"));
		s.capture.start();
		expect(s.capture.getState().phase).toBe("listening");
		expect(s.starts).toHaveLength(2);
		expect(JSON.stringify(s.capture.getState())).not.toContain("old");
	});

	test("subscribers see transitions until unsubscribed", async () => {
		const s = setup();
		const seen: string[] = [];
		const off = s.capture.subscribe(() =>
			seen.push(s.capture.getState().phase),
		);
		s.capture.start();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		off();
		s.starts[0].emit(result("late"));
		expect(seen).toEqual(["checking", "listening"]);
	});
});

describe("refusals and failures", () => {
	test.each([
		["language-pack-downloadable", "error"],
		["language-pack-downloading", "error"],
		["language-pack-unavailable", "unsupported"],
		["unsupported-insecure-context", "unsupported"],
		["unsupported-no-local-processing", "unsupported"],
		["availability-check-failed", "error"],
	] as const)("check refusal %s lands in %s and never starts", async (reason, phase) => {
		const s = setup();
		s.capture.start();
		s.checks[0].resolve({ status: "refused", reason });
		await flush();
		expect(s.capture.getState()).toMatchObject({ phase, reason });
		expect(s.starts).toHaveLength(0);
		expect(s.clock.size).toBe(0);
	});

	test("rejected check is an honest error", async () => {
		const s = setup();
		s.capture.start();
		s.checks[0].reject();
		await flush();
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "availability-check-failed",
		});
	});

	test("malformed capability fails closed", async () => {
		const s = setup();
		s.capture.start();
		s.checks[0].resolve({ status: "yes" } as unknown as VoiceCapability);
		await flush();
		expect(s.capture.getState()).toMatchObject({ phase: "error" });
		expect(s.starts).toHaveLength(0);
	});

	test("a retry after a transient refusal checks again", async () => {
		const s = setup();
		s.capture.start();
		s.checks[0].resolve({
			status: "refused",
			reason: "language-pack-downloading",
		});
		await flush();
		s.capture.start();
		expect(s.checks).toHaveLength(2);
		s.checks[1].resolve(AVAILABLE);
		await flush();
		expect(s.capture.getState().phase).toBe("listening");
	});

	test("engine start throwing is start-failed", async () => {
		const s = setup({ engine: fakeEngine({ startThrows: new Error("nope") }) });
		s.capture.start();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "start-failed",
		});
		expect(s.clock.size).toBe(0);
	});

	test("typed engine start errors keep their reason", async () => {
		const s = setup({
			engine: fakeEngine({
				startThrows: new VoiceEngineError("local-processing-not-enforced"),
			}),
		});
		s.capture.start();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "local-processing-not-enforced",
		});
	});

	test.each([
		"permission-denied",
		"no-speech",
		"audio-capture",
		"no-match",
	] as const)("engine error %s is reported as is", async (reason) => {
		const s = await listening();
		s.starts[0].emit({ type: "error", reason });
		expect(s.capture.getState()).toMatchObject({ phase: "error", reason });
		expect(s.starts[0].aborts).toBe(1);
		expect(s.clock.size).toBe(0);
	});

	test("unknown engine reason text is replaced by engine-error", async () => {
		const s = await listening();
		s.starts[0].emit({ type: "error", reason: "Mic is broken!" as never });
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "engine-error",
		});
	});

	test("end without a result is an error, not a silent idle", async () => {
		const s = await listening();
		s.starts[0].emit({ type: "end" });
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "ended-without-result",
		});
	});

	test("end while stopping without a result is also an error", async () => {
		const s = await listening();
		s.capture.stop();
		s.starts[0].emit({ type: "end" });
		expect(s.capture.getState()).toMatchObject({
			reason: "ended-without-result",
		});
	});

	test("oversize result is rejected and no text survives", async () => {
		const s = await listening();
		s.starts[0].emit(result("b".repeat(501)));
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "result-too-long",
		});
		expect(s.capture.accept("draft")).toBeNull();
	});

	test("too many, empty and malformed results are errors", async () => {
		for (const [alts, reason] of [
			[["a", "b", "c", "d"], "result-too-many-alternatives"],
			[[" "], "result-empty"],
			[[42], "result-invalid"],
		] as const) {
			const s = await listening();
			s.starts[0].emit({ type: "result", alternatives: alts });
			expect(s.capture.getState()).toMatchObject({ phase: "error", reason });
		}
	});

	test("stop() throwing is reported", async () => {
		const s = await listening();
		const original = s.starts[0];
		// Replace the live session's stop via a fresh engine whose stop throws.
		expect(original.stops).toBe(0);
		const throwing = createVoiceCapture({
			engine: {
				check: async () => AVAILABLE,
				start: () => ({
					stop() {
						throw new Error("stop failed");
					},
					abort() {},
				}),
			},
			native: false,
			locale: "en",
			timers: s.clock.timers,
		});
		throwing.probe();
		await flush();
		throwing.start();
		throwing.stop();
		expect(throwing.getState()).toMatchObject({
			phase: "error",
			reason: "engine-error",
		});
	});

	test("cancel after failure clears the error without a transcript", async () => {
		const s = await listening();
		s.starts[0].emit({ type: "error", reason: "no-speech" });
		s.capture.cancel();
		expect(s.capture.getState()).toMatchObject({ phase: "idle" });
	});
});

describe("timeout", () => {
	test("hard timeout aborts listening", async () => {
		const s = await listening({ timeoutMs: 1234 });
		expect(s.clock.delays).toEqual([1234]);
		s.clock.fireAll();
		expect(s.starts[0].aborts).toBe(1);
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "timeout",
		});
		s.starts[0].emit(result("too late"));
		expect(s.capture.getState()).toMatchObject({ reason: "timeout" });
	});

	test("timeout also covers a stuck stop", async () => {
		const s = await listening();
		s.capture.stop();
		s.clock.fireAll();
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "timeout",
		});
		expect(s.starts[0].aborts).toBe(1);
	});

	test("timeout covers a capability check that never settles", async () => {
		const s = setup();
		s.capture.start();
		s.clock.fireAll();
		expect(s.capture.getState()).toMatchObject({
			phase: "error",
			reason: "timeout",
		});
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.starts).toHaveLength(0);
		expect(s.capture.getState().phase).toBe("error");
	});

	test("invalid timeoutMs falls back to the default finite cap", () => {
		const s = setup({ timeoutMs: Number.POSITIVE_INFINITY });
		s.capture.start();
		expect(s.clock.delays).toEqual([VOICE_CAPTURE_TIMEOUT_MS]);
	});
});

describe("cancellation and fencing", () => {
	test("cancel while the probe is unresolved ignores its completion", async () => {
		const s = setup();
		s.capture.start();
		s.capture.cancel();
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.clock.size).toBe(0);
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.starts).toHaveLength(0);
		expect(s.capture.getState()).toMatchObject({ phase: "idle", ready: false });
	});

	test("cancel while listening aborts and a saved final callback is ignored", async () => {
		const s = await listening();
		const saved = s.starts[0].emit;
		s.capture.cancel();
		expect(s.starts[0].aborts).toBe(1);
		expect(s.clock.size).toBe(0);
		saved(result("late final"));
		saved({ type: "end" });
		saved({ type: "error", reason: "no-speech" });
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.capture.accept("draft")).toBeNull();
	});

	test.each([
		"account",
		"workspace",
		"list",
		"locale",
		"page",
	] as const)("invalidate(%s) discards like cancel", async (cause) => {
		const s = await listening();
		const saved = s.starts[0].emit;
		s.capture.invalidate(cause);
		saved(result("stale"));
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.starts[0].aborts).toBe(1);
	});

	test("dispose fences saved callbacks and silences subscribers", async () => {
		const s = await listening();
		const saved = s.starts[0].emit;
		let calls = 0;
		s.capture.subscribe(() => calls++);
		s.capture.dispose();
		expect(s.starts[0].aborts).toBe(1);
		expect(s.clock.size).toBe(0);
		saved(result("after unmount"));
		s.capture.start();
		s.capture.probe();
		expect(s.capture.accept("draft")).toBeNull();
		expect(calls).toBe(0);
		expect(s.starts).toHaveLength(1);
		expect(s.checks).toHaveLength(1);
		expect(s.capture.getState().phase).toBe("idle");
	});

	test("dispose during an unresolved check ignores its completion", async () => {
		const s = setup();
		s.capture.start();
		s.capture.dispose();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.starts).toHaveLength(0);
	});

	test("a newer session rejects callbacks from the older one", async () => {
		const s = await listening();
		const old = s.starts[0].emit;
		s.capture.cancel();
		s.capture.start(); // ready is true, so this listens synchronously
		expect(s.capture.getState().phase).toBe("listening");
		expect(s.starts).toHaveLength(2);
		old(result("from the old session"));
		old({ type: "end" });
		expect(s.capture.getState().phase).toBe("listening");
		s.starts[1].emit(result("from the new session"));
		expect(s.capture.getState()).toMatchObject({
			phase: "review",
			alternatives: ["from the new session"],
		});
	});

	test("session numbers only move forward", async () => {
		const s = await listening();
		const first = s.capture.getState().session;
		s.capture.cancel();
		s.capture.start();
		expect(s.capture.getState().session).toBeGreaterThan(first);
	});
});

const REENTRANT_ACTIONS = [
	["cancel", (c: VoiceCapture) => c.cancel()],
	["invalidate(account)", (c: VoiceCapture) => c.invalidate("account")],
	["dispose", (c: VoiceCapture) => c.dispose()],
] as const;

describe("reentrant cancellation from a checking notification", () => {
	test.each(
		(["probe", "start"] as const).flatMap((entry) =>
			REENTRANT_ACTIONS.map(([name, act]) => [entry, name, act] as const),
		),
	)("%s then %s in the listener never checks, listens or arms a timer", async (entry, _name, act) => {
		const s = setup();
		let acted = false;
		s.capture.subscribe(() => {
			if (acted || s.capture.getState().phase !== "checking") return;
			acted = true;
			act(s.capture);
		});
		s.capture[entry]();
		expect(acted).toBe(true);
		expect(s.checks).toHaveLength(0);
		expect(s.starts).toHaveLength(0);
		expect(s.clock.size).toBe(0);
		expect(s.capture.getState()).toMatchObject({ phase: "idle", ready: false });
		expect(s.capture.accept("original draft")).toBeNull();
		s.clock.fireAll();
		await flush();
		expect(s.checks).toHaveLength(0);
		expect(s.starts).toHaveLength(0);
		expect(s.capture.getState()).toMatchObject({ phase: "idle", ready: false });
	});

	test.each([
		"probe",
		"start",
	] as const)("%s superseded by a newer session in the listener leaves only that session", async (entry) => {
		const s = setup();
		let acted = false;
		s.capture.subscribe(() => {
			if (acted || s.capture.getState().phase !== "checking") return;
			acted = true;
			s.capture.cancel();
			s.capture[entry]();
		});
		s.capture[entry]();
		expect(s.checks).toHaveLength(1);
		expect(s.clock.size).toBe(1);
		expect(s.capture.getState().phase).toBe("checking");
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.capture.getState().phase).toBe(
			entry === "start" ? "listening" : "idle",
		);
		expect(s.starts).toHaveLength(entry === "start" ? 1 : 0);
	});

	test("ordinary probe and start still check, arm one timer and proceed", async () => {
		const s = setup();
		const seen: string[] = [];
		s.capture.subscribe(() => seen.push(s.capture.getState().phase));
		s.capture.probe();
		expect(s.checks).toHaveLength(1);
		expect(s.clock.delays).toEqual([VOICE_CAPTURE_TIMEOUT_MS]);
		s.checks[0].resolve(AVAILABLE);
		await flush();
		expect(s.clock.size).toBe(0);
		s.capture.start();
		expect(seen).toEqual(["checking", "idle", "listening"]);
		expect(s.starts).toHaveLength(1);
		expect(s.clock.delays).toEqual([VOICE_CAPTURE_TIMEOUT_MS]);
	});
});

describe("reentrant cancellation from a stopping notification", () => {
	const abortedStop = (rec: Started) => {
		if (rec.aborts > 0) throw new Error("stop after abort");
	};

	async function listeningViaProbe(over: Parameters<typeof setup>[0]) {
		const s = setup(over);
		s.capture.probe();
		s.checks[0].resolve(AVAILABLE);
		await flush();
		s.capture.start();
		expect(s.capture.getState().phase).toBe("listening");
		return s;
	}

	test.each(
		(["check", "probe"] as const).flatMap((path) =>
			REENTRANT_ACTIONS.map(([name, act]) => [path, name, act] as const),
		),
	)("after %s, %s in the listener aborts once, never stops and stays idle", async (path, _name, act) => {
		const over = { engine: fakeEngine({ onStop: abortedStop }) };
		const s = await (path === "check"
			? listening(over)
			: listeningViaProbe(over));
		const saved = s.starts[0].emit;
		let acted = false;
		s.capture.subscribe(() => {
			if (acted || s.capture.getState().phase !== "stopping") return;
			acted = true;
			act(s.capture);
		});
		s.capture.stop();
		expect(acted).toBe(true);
		expect(s.starts[0].aborts).toBe(1);
		expect(s.starts[0].stops).toBe(0);
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.clock.size).toBe(0);
		saved(result("late"));
		s.clock.fireAll();
		await flush();
		expect(s.capture.getState().phase).toBe("idle");
		expect(s.capture.accept("original draft")).toBeNull();
	});

	test.each([
		"cancel",
		"dispose",
		"restart",
	] as const)("stop() that %ss itself and then throws does not overwrite the newer state", async (how) => {
		let capture: VoiceCapture | undefined;
		const engine = fakeEngine({
			onStop: () => {
				if (how === "cancel") capture?.cancel();
				else if (how === "dispose") capture?.dispose();
				else {
					capture?.cancel();
					capture?.start();
				}
				throw new Error("stop failed");
			},
		});
		const s = await listening({ engine });
		capture = s.capture;
		s.capture.stop();
		expect(s.starts[0].stops).toBe(1);
		expect(s.starts[0].aborts).toBe(1);
		if (how === "restart") {
			expect(s.capture.getState().phase).toBe("listening");
			expect(s.starts).toHaveLength(2);
			expect(s.starts[1].aborts).toBe(0);
			expect(s.clock.size).toBe(1);
		} else {
			expect(s.capture.getState().phase).toBe("idle");
			expect(s.clock.size).toBe(0);
		}
	});
});

test("cancellation from a listening notification prevents microphone start", async () => {
	const s = setup();
	s.capture.subscribe(() => {
		if (s.capture.getState().phase === "listening") s.capture.cancel();
	});
	s.capture.start();
	s.checks[0].resolve(AVAILABLE);
	await flush();
	expect(s.capture.getState().phase).toBe("idle");
	expect(s.starts).toHaveLength(0);
});
