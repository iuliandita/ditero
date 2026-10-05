import {
	VOICE_MAX_ALTERNATIVES,
	type VoiceCapability,
	type VoiceEngine,
	VoiceEngineError,
	type VoiceEngineEvent,
	type VoiceEngineSession,
	type VoiceReason,
} from "../../domain/voice-capture.ts";

export interface LocalSpeechRecognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	// Present only where the browser implements on-device recognition.
	processLocally?: boolean;
	onresult: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onnomatch: ((event: unknown) => void) | null;
	onend: ((event: unknown) => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

export interface LocalSpeechRecognitionConstructor {
	new (): LocalSpeechRecognition;
	available?(options: {
		langs: string[];
		processLocally: boolean;
	}): Promise<unknown>;
}

export interface SpeechEnvironment {
	isSecureContext: unknown;
	/** True when the NativeDitero bridge exists (Android and desktop shells). */
	hasNative: boolean;
	SpeechRecognition: unknown;
	webkitSpeechRecognition: unknown;
}

export function browserSpeechEnvironment(
	scope: object = globalThis,
): SpeechEnvironment {
	const read = (key: string): unknown => Reflect.get(scope, key) as unknown;
	return {
		isSecureContext: read("isSecureContext"),
		hasNative: "NativeDitero" in scope,
		SpeechRecognition: read("SpeechRecognition"),
		webkitSpeechRecognition: read("webkitSpeechRecognition"),
	};
}

type Resolved =
	| { ok: true; ctor: LocalSpeechRecognitionConstructor }
	| { ok: false; reason: VoiceReason };

function resolveConstructor(env: SpeechEnvironment): Resolved {
	if (env.hasNative) return { ok: false, reason: "unsupported-native" };
	if (env.isSecureContext !== true) {
		return { ok: false, reason: "unsupported-insecure-context" };
	}
	const ctor =
		typeof env.SpeechRecognition === "function"
			? env.SpeechRecognition
			: typeof env.webkitSpeechRecognition === "function"
				? env.webkitSpeechRecognition
				: null;
	if (ctor === null) return { ok: false, reason: "unsupported-no-api" };
	return { ok: true, ctor: ctor as LocalSpeechRecognitionConstructor };
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

const AVAILABILITY_REASONS: Readonly<Record<string, VoiceReason>> = {
	downloadable: "language-pack-downloadable",
	downloading: "language-pack-downloading",
	unavailable: "language-pack-unavailable",
};

const ERROR_REASONS: Readonly<Record<string, VoiceReason>> = {
	"not-allowed": "permission-denied",
	"service-not-allowed": "permission-denied",
	"no-speech": "no-speech",
	"audio-capture": "audio-capture",
	"language-not-supported": "language-pack-unavailable",
};

// Upper bound on how many alternatives we read from an untrusted result before
// handing it to the domain, which rejects anything above its own limit.
const MAX_READ_ALTERNATIVES = 32;

// undefined: nothing final yet. null: malformed or ambiguous. array: one final.
function readFinalAlternatives(event: unknown): unknown[] | null | undefined {
	if (!isObject(event) || !isObject(event.results)) return null;
	const results = event.results;
	const count = results.length;
	if (
		typeof count !== "number" ||
		!Number.isInteger(count) ||
		count < 0 ||
		count > 32
	) {
		return null;
	}
	let found: unknown[] | undefined;
	for (let i = 0; i < count; i++) {
		const result = results[i];
		if (!isObject(result)) return null;
		if (result.isFinal !== true) continue;
		if (found !== undefined) return null;
		const length = result.length;
		if (
			typeof length !== "number" ||
			!Number.isInteger(length) ||
			length < 0 ||
			length > MAX_READ_ALTERNATIVES
		) {
			return null;
		}
		found = [];
		for (let j = 0; j < length; j++) {
			const alternative = result[j];
			found.push(isObject(alternative) ? alternative.transcript : undefined);
		}
	}
	return found;
}

function detach(recognition: LocalSpeechRecognition) {
	recognition.onresult = null;
	recognition.onerror = null;
	recognition.onnomatch = null;
	recognition.onend = null;
}

export function createBrowserVoiceEngine(
	env: SpeechEnvironment = browserSpeechEnvironment(),
): VoiceEngine {
	return {
		async check(tag): Promise<VoiceCapability> {
			const resolved = resolveConstructor(env);
			if (!resolved.ok) return { status: "refused", reason: resolved.reason };
			const { ctor } = resolved;
			if (typeof ctor.available !== "function") {
				return { status: "refused", reason: "unsupported-no-local-processing" };
			}
			// Probe the instance for the property; assigning it blindly would
			// "succeed" on browsers that do not implement on-device mode.
			try {
				if (!("processLocally" in new ctor())) {
					return {
						status: "refused",
						reason: "unsupported-no-local-processing",
					};
				}
			} catch {
				return { status: "refused", reason: "unsupported-no-api" };
			}
			let availability: unknown;
			try {
				availability = await ctor.available({
					langs: [tag],
					processLocally: true,
				});
			} catch {
				return { status: "refused", reason: "availability-check-failed" };
			}
			if (availability === "available") return { status: "available" };
			const reason =
				typeof availability === "string" &&
				Object.hasOwn(AVAILABILITY_REASONS, availability)
					? AVAILABILITY_REASONS[availability]
					: "availability-check-failed";
			return { status: "refused", reason };
		},

		start(tag, onEvent): VoiceEngineSession {
			const resolved = resolveConstructor(env);
			if (!resolved.ok) throw new VoiceEngineError(resolved.reason);
			const recognition = new resolved.ctor();
			if (!("processLocally" in recognition)) {
				throw new VoiceEngineError("unsupported-no-local-processing");
			}
			recognition.lang = tag;
			recognition.continuous = false;
			recognition.interimResults = false;
			recognition.maxAlternatives = VOICE_MAX_ALTERNATIVES;
			recognition.processLocally = true;
			// Verify before starting: a setter that silently ignores the value
			// would leave the engine free to use a remote service.
			if (recognition.processLocally !== true) {
				throw new VoiceEngineError("local-processing-not-enforced");
			}
			if (recognition.lang !== tag)
				throw new VoiceEngineError("locale-not-applied");

			const emit = (event: VoiceEngineEvent) => onEvent(event);
			recognition.onresult = (event) => {
				const alternatives = readFinalAlternatives(event);
				if (alternatives === undefined) return;
				emit({ type: "result", alternatives });
			};
			recognition.onerror = (event) => {
				const code = isObject(event) ? event.error : undefined;
				const reason =
					typeof code === "string" && Object.hasOwn(ERROR_REASONS, code)
						? ERROR_REASONS[code]
						: "engine-error";
				emit({ type: "error", reason });
			};
			recognition.onnomatch = () => emit({ type: "error", reason: "no-match" });
			recognition.onend = () => emit({ type: "end" });

			try {
				recognition.start();
			} catch (error) {
				detach(recognition);
				throw error;
			}
			return {
				stop() {
					recognition.stop();
				},
				abort() {
					detach(recognition);
					try {
						recognition.abort();
					} catch {
						// Already stopped; handlers are detached either way.
					}
				},
			};
		},
	};
}
