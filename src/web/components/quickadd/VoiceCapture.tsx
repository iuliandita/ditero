import { Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoiceReason } from "../../../domain/voice-capture.ts";
import { m } from "../../../paraglide/messages.js";
import type { VoiceView } from "./useVoiceCapture.ts";

// Coarse pointers get 44px in both directions; fine pointers keep the stock size.
const TOUCH =
	"[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

function reasonMessage(reason: VoiceReason): string {
	switch (reason) {
		case "unsupported-native":
			return m.quickadd_voice_unsupported_native();
		case "unsupported-locale":
			return m.quickadd_voice_unsupported_locale();
		case "unsupported-insecure-context":
			return m.quickadd_voice_insecure();
		case "unsupported-no-api":
		case "unsupported-no-local-processing":
			return m.quickadd_voice_unsupported();
		case "language-pack-unavailable":
			return m.quickadd_voice_unsupported_pack();
		case "language-pack-downloadable":
		case "language-pack-downloading":
			return m.quickadd_voice_pack_pending();
		case "permission-denied":
			return m.quickadd_voice_permission();
		case "audio-capture":
			return m.quickadd_voice_audio_capture();
		case "no-speech":
		case "no-match":
			return m.quickadd_voice_no_speech();
		case "result-too-long":
			return m.quickadd_voice_too_long();
		default:
			return m.quickadd_voice_failed();
	}
}

function Review({
	alternatives,
	onUse,
	onRetry,
	onCancel,
}: {
	alternatives: readonly string[];
	onUse: (index: number) => void;
	onRetry: () => void;
	onCancel: () => void;
}) {
	const [picked, setPicked] = useState(0);
	const firstChoice = useRef<HTMLInputElement>(null);
	const useButton = useRef<HTMLButtonElement>(null);
	// Review only mounts after an explicit listening session, so taking focus
	// here never interrupts a passive probe or an identity change.
	useEffect(() => {
		(firstChoice.current ?? useButton.current)?.focus();
	}, []);
	return (
		<div data-testid="quickadd-voice-review" className="flex flex-col gap-2">
			<p
				id="quickadd-voice-heard"
				role="status"
				className="relative text-xs text-muted-foreground"
			>
				{m.quickadd_voice_heard()}
				<span className="sr-only">: {alternatives[picked]}</span>
			</p>
			{alternatives.length > 1 ? (
				<div
					role="radiogroup"
					aria-label={m.quickadd_voice_choices()}
					className="flex flex-col"
				>
					{alternatives.map((text, i) => (
						<label
							key={text}
							data-testid="quickadd-voice-choice"
							className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-sm hover:bg-accent"
						>
							<input
								ref={i === 0 ? firstChoice : undefined}
								type="radio"
								name="quickadd-voice-choice"
								className="size-4 shrink-0"
								checked={picked === i}
								onChange={() => setPicked(i)}
							/>
							<span className="min-w-0 break-words">{text}</span>
						</label>
					))}
				</div>
			) : (
				<p data-testid="quickadd-voice-text" className="break-words text-sm">
					{alternatives[0]}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					ref={useButton}
					variant="outline"
					data-testid="quickadd-voice-use"
					aria-describedby="quickadd-voice-heard"
					className={TOUCH}
					onClick={() => onUse(picked)}
				>
					{m.quickadd_voice_use()}
				</Button>
				<Button
					type="button"
					variant="ghost"
					data-testid="quickadd-voice-retry"
					className={TOUCH}
					onClick={onRetry}
				>
					{m.quickadd_voice_retry()}
				</Button>
				<Button
					type="button"
					variant="ghost"
					data-testid="quickadd-voice-cancel"
					className={TOUCH}
					onClick={onCancel}
				>
					{m.quickadd_voice_cancel()}
				</Button>
			</div>
		</div>
	);
}

// Inline under the field. The transcript only ever reaches the draft through
// `onUse`; everything else leaves the typed text untouched.
export function VoiceCapture({
	voice,
	onUse,
	onFocusInput,
}: {
	voice: VoiceView;
	onUse: (index: number) => void;
	/** Returns focus to the typed field after an explicit cancellation. */
	onFocusInput: () => void;
}) {
	const state = voice.state;
	const phase = state?.phase ?? null;
	const ready = state?.phase === "idle" && state.ready;
	const stopRef = useRef<HTMLButtonElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const checkRef = useRef<HTMLButtonElement>(null);
	const startRef = useRef<HTMLButtonElement>(null);
	const before = useRef<typeof phase>(null);
	// Set by the user's own Dictate / Check again click. The automatic open-time
	// probe and identity changes never set it, so they never move focus.
	const explicit = useRef(false);

	useEffect(() => {
		const prev = before.current;
		before.current = phase;
		if (phase === "listening" && prev !== "listening") stopRef.current?.focus();
		else if (phase === "stopping" && prev === "listening")
			cancelRef.current?.focus();
		else if (
			phase === "error" &&
			(prev === "listening" || prev === "stopping" || explicit.current)
		)
			checkRef.current?.focus();
		else if (
			phase === "idle" &&
			ready &&
			prev === "checking" &&
			explicit.current
		)
			startRef.current?.focus();
		else if (phase === "unsupported" && explicit.current) onFocusInput();
		if (phase !== "checking" && phase !== "listening" && phase !== "stopping")
			explicit.current = false;
	}, [phase, ready, onFocusInput]);

	const cancel = () => {
		voice.cancel();
		onFocusInput();
	};
	const dictate = () => {
		explicit.current = true;
		voice.start();
	};
	const checkAgain = () => {
		explicit.current = true;
		voice.retry();
	};

	if (!state) return null;

	if (state.phase === "review") {
		return (
			<Review
				key={state.session}
				alternatives={state.alternatives}
				onUse={onUse}
				onRetry={voice.retryAfterReview}
				onCancel={cancel}
			/>
		);
	}

	if (state.phase === "error") {
		// A language pack that is still downloadable or downloading is a wait,
		// not a failure: quiet status, same two-step Check again recovery.
		const packWait =
			state.reason === "language-pack-downloadable" ||
			state.reason === "language-pack-downloading";
		return (
			<div
				data-testid="quickadd-voice"
				className="flex flex-wrap items-center gap-2"
			>
				{packWait ? (
					<p
						role="status"
						aria-live="polite"
						data-testid="quickadd-voice-status"
						className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground"
					>
						{reasonMessage(state.reason)}
					</p>
				) : (
					<p
						role="alert"
						data-testid="quickadd-voice-error"
						className="min-w-0 flex-1 basis-48 text-sm text-destructive"
					>
						{reasonMessage(state.reason)}
					</p>
				)}
				<Button
					ref={checkRef}
					type="button"
					variant="ghost"
					data-testid="quickadd-voice-retry"
					className={TOUCH}
					onClick={checkAgain}
				>
					{m.quickadd_voice_check_again()}
				</Button>
			</div>
		);
	}

	if (state.phase === "unsupported") {
		return (
			<p
				role="status"
				data-testid="quickadd-voice-status"
				className="text-xs text-muted-foreground"
			>
				{reasonMessage(state.reason)}
			</p>
		);
	}

	const active =
		state.phase === "checking" ||
		state.phase === "listening" ||
		state.phase === "stopping";
	const status =
		state.phase === "listening"
			? m.quickadd_voice_listening()
			: state.phase === "stopping"
				? m.quickadd_voice_stopping()
				: state.phase === "checking"
					? m.quickadd_voice_checking()
					: m.quickadd_voice_privacy();
	// The mic starts only from idle+ready, so start() stays inside the click.
	const micReady = state.phase === "idle" && state.ready;

	return (
		<div
			data-testid="quickadd-voice"
			className="flex flex-wrap items-center gap-2"
		>
			{state.phase === "listening" && (
				<Button
					ref={stopRef}
					type="button"
					variant="outline"
					data-testid="quickadd-voice-stop"
					className={TOUCH}
					onClick={voice.stop}
				>
					{m.quickadd_voice_stop()}
				</Button>
			)}
			{active && (
				<Button
					ref={cancelRef}
					type="button"
					variant="ghost"
					data-testid="quickadd-voice-cancel"
					className={TOUCH}
					onClick={cancel}
				>
					{m.quickadd_voice_cancel()}
				</Button>
			)}
			{(state.phase === "idle" || state.phase === "checking") && (
				<Button
					ref={startRef}
					type="button"
					variant="outline"
					data-testid="quickadd-voice-start"
					className={TOUCH}
					disabled={!micReady}
					aria-describedby="quickadd-voice-status"
					onClick={dictate}
				>
					<Mic aria-hidden="true" />
					{m.quickadd_voice_start()}
				</Button>
			)}
			{state.phase === "idle" && !state.ready && (
				<Button
					ref={checkRef}
					type="button"
					variant="ghost"
					data-testid="quickadd-voice-retry"
					className={TOUCH}
					onClick={checkAgain}
				>
					{m.quickadd_voice_check_again()}
				</Button>
			)}
			<p
				id="quickadd-voice-status"
				role="status"
				aria-live="polite"
				data-testid="quickadd-voice-status"
				className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground"
			>
				{status}
			</p>
		</div>
	);
}
