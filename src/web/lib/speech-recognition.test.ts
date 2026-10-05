import { describe, expect, test } from "vitest";
import {
	createVoiceCapture,
	VoiceEngineError,
	type VoiceEngineEvent,
	type VoiceTimers,
} from "../../domain/voice-capture.ts";
import {
	browserSpeechEnvironment,
	createBrowserVoiceEngine,
	type LocalSpeechRecognitionConstructor,
	type SpeechEnvironment,
} from "./speech-recognition.ts";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type LocalMode = "supported" | "missing" | "readback-false";

// Fake of the experimental API. Records what the page did to it and when.
function makeRecognition(
	opts: {
		local?: LocalMode;
		available?: ((options: unknown) => unknown) | "absent";
		startThrows?: boolean;
	} = {},
) {
	const local = opts.local ?? "supported";
	const instances: FakeRecognition[] = [];
	const availableCalls: unknown[] = [];

	class FakeRecognition {
		lang = "";
		continuous = true;
		interimResults = true;
		maxAlternatives = 1;
		onresult: ((event: unknown) => void) | null = null;
		onerror: ((event: unknown) => void) | null = null;
		onnomatch: ((event: unknown) => void) | null = null;
		onend: ((event: unknown) => void) | null = null;
		starts = 0;
		stops = 0;
		aborts = 0;
		// Snapshot of the configuration at the moment start() was called.
		atStart: {
			local: unknown;
			lang: string;
			continuous: boolean;
			interim: boolean;
			max: number;
		} | null = null;
		private localValue = false;

		constructor() {
			instances.push(this);
			if (local === "supported") {
				Object.defineProperty(this, "processLocally", {
					configurable: true,
					enumerable: true,
					get: () => this.localValue,
					set: (value: boolean) => {
						this.localValue = value;
					},
				});
			} else if (local === "readback-false") {
				Object.defineProperty(this, "processLocally", {
					configurable: true,
					get: () => false,
					set: () => {},
				});
			}
		}
		start() {
			if (opts.startThrows) throw new Error("InvalidStateError");
			this.starts++;
			this.atStart = {
				local: (this as { processLocally?: unknown }).processLocally,
				lang: this.lang,
				continuous: this.continuous,
				interim: this.interimResults,
				max: this.maxAlternatives,
			};
		}
		stop() {
			this.stops++;
		}
		abort() {
			this.aborts++;
		}
	}

	const ctor = FakeRecognition as unknown as LocalSpeechRecognitionConstructor;
	if (opts.available !== "absent") {
		const impl = opts.available ?? (async () => "available");
		(ctor as unknown as Record<string, unknown>).available = (
			options: unknown,
		) => {
			availableCalls.push(options);
			return impl(options);
		};
	}
	return { ctor, instances, availableCalls };
}

const finalResult = (...texts: string[]) => ({
	resultIndex: 0,
	results: [
		Object.assign(
			texts.map((transcript) => ({ transcript, confidence: 0.9 })),
			{ isFinal: true },
		),
	],
});

function env(over: Partial<SpeechEnvironment> = {}): SpeechEnvironment {
	return {
		isSecureContext: true,
		hasNative: false,
		SpeechRecognition: undefined,
		webkitSpeechRecognition: undefined,
		...over,
	};
}

describe("browserSpeechEnvironment", () => {
	test("reads the scope and detects NativeDitero by presence", () => {
		const ctor = class {};
		const plain = browserSpeechEnvironment({
			isSecureContext: true,
			SpeechRecognition: ctor,
		});
		expect(plain).toMatchObject({
			isSecureContext: true,
			hasNative: false,
			SpeechRecognition: ctor,
		});
		expect(
			browserSpeechEnvironment({ NativeDitero: undefined }).hasNative,
		).toBe(true);
	});
});

describe("check", () => {
	test("exactly-available probe asks only for the exact tag, locally, and never starts", async () => {
		const fake = makeRecognition();
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		await expect(engine.check("de-DE")).resolves.toEqual({
			status: "available",
		});
		expect(fake.availableCalls).toEqual([
			{ langs: ["de-DE"], processLocally: true },
		]);
		expect(fake.instances.every((r) => r.starts === 0)).toBe(true);
	});

	test("webkit-prefixed constructor is used when the standard one is absent", async () => {
		const fake = makeRecognition();
		const engine = createBrowserVoiceEngine(
			env({ webkitSpeechRecognition: fake.ctor }),
		);
		await expect(engine.check("en-US")).resolves.toEqual({
			status: "available",
		});
	});

	test.each([
		[
			"insecure context",
			{ isSecureContext: false },
			"unsupported-insecure-context",
		],
		[
			"secure flag missing",
			{ isSecureContext: undefined },
			"unsupported-insecure-context",
		],
		[
			"truthy but not true",
			{ isSecureContext: "true" },
			"unsupported-insecure-context",
		],
		["native shell", { hasNative: true }, "unsupported-native"],
	] as const)("%s refuses before constructing or probing anything", async (_name, over, reason) => {
		const fake = makeRecognition();
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor, ...over }),
		);
		await expect(engine.check("en-US")).resolves.toEqual({
			status: "refused",
			reason,
		});
		expect(fake.instances).toHaveLength(0);
		expect(fake.availableCalls).toHaveLength(0);
	});

	test("native spoof is false even with a perfect API present", async () => {
		const fake = makeRecognition();
		const scope = browserSpeechEnvironment({
			isSecureContext: true,
			SpeechRecognition: fake.ctor,
			NativeDitero: {},
		});
		const engine = createBrowserVoiceEngine(scope);
		await expect(engine.check("en-US")).resolves.toMatchObject({
			reason: "unsupported-native",
		});
		expect(() => engine.start("en-US", () => {})).toThrow(VoiceEngineError);
		expect(fake.instances).toHaveLength(0);
	});

	test("no API", async () => {
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: {}, webkitSpeechRecognition: "x" }),
		);
		await expect(engine.check("en-US")).resolves.toMatchObject({
			reason: "unsupported-no-api",
		});
	});

	test("no static available()", async () => {
		const fake = makeRecognition({ available: "absent" });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		await expect(engine.check("en-US")).resolves.toMatchObject({
			reason: "unsupported-no-local-processing",
		});
		expect(fake.instances).toHaveLength(0);
	});

	test("recognizer without processLocally support is refused, not assigned to", async () => {
		const fake = makeRecognition({ local: "missing" });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		await expect(engine.check("en-US")).resolves.toMatchObject({
			reason: "unsupported-no-local-processing",
		});
		expect(fake.availableCalls).toHaveLength(0);
		for (const r of fake.instances) expect("processLocally" in r).toBe(false);
	});

	test.each([
		["downloadable", "language-pack-downloadable"],
		["downloading", "language-pack-downloading"],
		["unavailable", "language-pack-unavailable"],
		["Available", "availability-check-failed"],
		[true, "availability-check-failed"],
		[undefined, "availability-check-failed"],
		["constructor", "availability-check-failed"],
	])("availability %j is %s and is not treated as available", async (value, reason) => {
		const fake = makeRecognition({ available: async () => value });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		await expect(engine.check("fr-FR")).resolves.toEqual({
			status: "refused",
			reason,
		});
	});

	test("rejecting and synchronously throwing available() are check failures", async () => {
		const rejecting = makeRecognition({
			available: async () => Promise.reject(new Error("x")),
		});
		const throwing = makeRecognition({
			available: () => {
				throw new Error("y");
			},
		});
		for (const fake of [rejecting, throwing]) {
			const engine = createBrowserVoiceEngine(
				env({ SpeechRecognition: fake.ctor }),
			);
			await expect(engine.check("ro-RO")).resolves.toEqual({
				status: "refused",
				reason: "availability-check-failed",
			});
		}
	});
});

describe("start", () => {
	test("configures exactly, verifies local processing, and only then starts", () => {
		const fake = makeRecognition();
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		engine.start("es-ES", () => {});
		expect(fake.instances).toHaveLength(1);
		const [rec] = fake.instances;
		expect(rec.starts).toBe(1);
		expect(rec.atStart).toEqual({
			local: true,
			lang: "es-ES",
			continuous: false,
			interim: false,
			max: 3,
		});
	});

	test("a setter that ignores processLocally refuses before start", () => {
		const fake = makeRecognition({ local: "readback-false" });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		expect(() => engine.start("en-US", () => {})).toThrowError(
			expect.objectContaining({ reason: "local-processing-not-enforced" }),
		);
		expect(fake.instances[0].starts).toBe(0);
	});

	test("missing processLocally refuses before start", () => {
		const fake = makeRecognition({ local: "missing" });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		expect(() => engine.start("en-US", () => {})).toThrowError(
			expect.objectContaining({ reason: "unsupported-no-local-processing" }),
		);
		expect(fake.instances[0].starts).toBe(0);
	});

	test("start() throwing detaches handlers and rethrows", () => {
		const fake = makeRecognition({ startThrows: true });
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		expect(() => engine.start("en-US", () => {})).toThrow("InvalidStateError");
		const [rec] = fake.instances;
		expect([rec.onresult, rec.onerror, rec.onnomatch, rec.onend]).toEqual([
			null,
			null,
			null,
			null,
		]);
	});

	test("stop() delegates to stop and abort() detaches then aborts, idempotently", () => {
		const fake = makeRecognition();
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		const session = engine.start("en-US", () => {});
		const [rec] = fake.instances;
		session.stop();
		expect(rec.stops).toBe(1);
		expect(rec.aborts).toBe(0);
		session.abort();
		session.abort();
		expect(rec.aborts).toBe(2);
		expect([rec.onresult, rec.onerror, rec.onnomatch, rec.onend]).toEqual([
			null,
			null,
			null,
			null,
		]);
	});
});

describe("recognition events", () => {
	function started() {
		const fake = makeRecognition();
		const events: VoiceEngineEvent[] = [];
		const engine = createBrowserVoiceEngine(
			env({ SpeechRecognition: fake.ctor }),
		);
		const session = engine.start("en-US", (e) => events.push(e));
		return { rec: fake.instances[0], events, session };
	}

	test("final result forwards raw alternatives", () => {
		const { rec, events } = started();
		rec.onresult?.(finalResult("buy milk", "buy mill"));
		expect(events).toEqual([
			{ type: "result", alternatives: ["buy milk", "buy mill"] },
		]);
	});

	test("interim-only results are ignored", () => {
		const { rec, events } = started();
		rec.onresult?.({
			results: [Object.assign([{ transcript: "buy" }], { isFinal: false })],
		});
		expect(events).toEqual([]);
	});

	test.each([
		["no event", undefined],
		["no results", {}],
		["non-numeric length", { results: { length: "1" } }],
		["unbounded length", { results: { length: Number.MAX_SAFE_INTEGER } }],
		["non-object result", { results: [5] }],
		[
			"two finals",
			{ results: [...finalResult("a").results, ...finalResult("b").results] },
		],
		[
			"absurd alternative count",
			{
				results: [
					Object.assign(new Array(1000).fill({ transcript: "a" }), {
						isFinal: true,
					}),
				],
			},
		],
	])("malformed result (%s) is forwarded as invalid, never as text", (_name, event) => {
		const { rec, events } = started();
		rec.onresult?.(event);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "result", alternatives: null });
	});

	test("non-string transcripts reach the domain as non-strings for rejection", () => {
		const { rec, events } = started();
		rec.onresult?.({
			results: [Object.assign([{ transcript: 7 }], { isFinal: true })],
		});
		expect(events).toEqual([{ type: "result", alternatives: [7] }]);
	});

	test.each([
		["not-allowed", "permission-denied"],
		["service-not-allowed", "permission-denied"],
		["no-speech", "no-speech"],
		["audio-capture", "audio-capture"],
		["language-not-supported", "language-pack-unavailable"],
		["network", "engine-error"],
		["aborted", "engine-error"],
		["toString", "engine-error"],
	])("error %s maps to %s", (code, reason) => {
		const { rec, events } = started();
		rec.onerror?.({ error: code });
		expect(events).toEqual([{ type: "error", reason }]);
	});

	test("malformed error and nomatch and end", () => {
		const { rec, events } = started();
		rec.onerror?.(null);
		rec.onnomatch?.({});
		rec.onend?.({});
		expect(events).toEqual([
			{ type: "error", reason: "engine-error" },
			{ type: "error", reason: "no-match" },
			{ type: "end" },
		]);
	});

	test("after abort the old recognizer's handlers no longer exist", () => {
		const { rec, events, session } = started();
		session.abort();
		expect(rec.onresult).toBeNull();
		expect(events).toEqual([]);
	});
});

describe("adapter driven by the controller", () => {
	function manualTimers() {
		const pending = new Map<number, () => void>();
		let next = 0;
		const timers: VoiceTimers = {
			setTimeout(fn) {
				pending.set(++next, fn);
				return next;
			},
			clearTimeout(handle) {
				pending.delete(handle as number);
			},
		};
		return {
			timers,
			fire: () =>
				[...pending.values()].forEach((fn) => {
					fn();
				}),
			pending,
		};
	}

	function wire(over: Partial<SpeechEnvironment> = {}, locale = "ro") {
		const fake = makeRecognition();
		const clock = manualTimers();
		const capture = createVoiceCapture({
			engine: createBrowserVoiceEngine(
				env({ SpeechRecognition: fake.ctor, ...over }),
			),
			native: over.hasNative ?? false,
			locale,
			timers: clock.timers,
		});
		return { fake, clock, capture };
	}

	test("probe, explicit start, final result reaches review, accept appends", async () => {
		const { fake, capture } = wire();
		capture.probe();
		await flush();
		expect(capture.getState()).toMatchObject({ phase: "idle", ready: true });
		expect(fake.availableCalls).toEqual([
			{ langs: ["ro-RO"], processLocally: true },
		]);
		capture.start();
		expect(capture.getState().phase).toBe("listening");
		const live = fake.instances.at(-1);
		expect(live?.atStart).toMatchObject({
			local: true,
			lang: "ro-RO",
			continuous: false,
		});
		live?.onresult?.(finalResult("  cumpără lapte "));
		expect(capture.getState()).toMatchObject({
			phase: "review",
			alternatives: ["cumpără lapte"],
		});
		expect(capture.accept("de făcut:")).toBe("de făcut: cumpără lapte");
	});

	test("late final after cancel is ignored and recognizer was aborted", async () => {
		const { fake, capture } = wire({}, "fr");
		capture.start();
		await flush();
		expect(capture.getState().phase).toBe("listening");
		const live = fake.instances.at(-1);
		const staleHandler = live?.onresult;
		capture.cancel();
		expect(live?.aborts).toBe(1);
		staleHandler?.(finalResult("tard"));
		expect(capture.getState().phase).toBe("idle");
	});

	test("end without result and denied permission are honest errors", async () => {
		const first = wire();
		first.capture.start();
		await flush();
		first.fake.instances.at(-1)?.onend?.({});
		expect(first.capture.getState()).toMatchObject({
			phase: "error",
			reason: "ended-without-result",
		});

		const second = wire();
		second.capture.start();
		await flush();
		second.fake.instances.at(-1)?.onerror?.({ error: "not-allowed" });
		expect(second.capture.getState()).toMatchObject({
			phase: "error",
			reason: "permission-denied",
		});
	});

	test("oversize speech is rejected rather than truncated", async () => {
		const { fake, capture } = wire();
		capture.start();
		await flush();
		fake.instances.at(-1)?.onresult?.(finalResult("x".repeat(501)));
		expect(capture.getState()).toMatchObject({
			phase: "error",
			reason: "result-too-long",
		});
	});

	test("timeout aborts the recognizer", async () => {
		const { fake, clock, capture } = wire();
		capture.start();
		await flush();
		clock.fire();
		expect(fake.instances.at(-1)?.aborts).toBe(1);
		expect(capture.getState()).toMatchObject({
			phase: "error",
			reason: "timeout",
		});
	});

	test("native shell never constructs a recognizer", () => {
		const { fake, capture } = wire({ hasNative: true });
		capture.probe();
		capture.start();
		expect(capture.getState()).toMatchObject({
			phase: "unsupported",
			reason: "unsupported-native",
		});
		expect(fake.instances).toHaveLength(0);
		expect(fake.availableCalls).toHaveLength(0);
	});

	test("downloadable pack refuses start and does not construct a listening recognizer", async () => {
		const fake = makeRecognition({ available: async () => "downloadable" });
		const capture = createVoiceCapture({
			engine: createBrowserVoiceEngine(env({ SpeechRecognition: fake.ctor })),
			native: false,
			locale: "ar",
		});
		capture.start();
		await flush();
		expect(capture.getState()).toMatchObject({
			phase: "error",
			reason: "language-pack-downloadable",
		});
		expect(fake.instances.every((r) => r.starts === 0)).toBe(true);
		capture.dispose();
	});
});
