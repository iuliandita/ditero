import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import {
	formatMMSS,
	phaseLabel,
	remainingSecFrom,
} from "../../focus/timer-core.ts";
import { useFocusTimer } from "../../focus/useFocusTimer.tsx";

// Persistent app-level mini-surface (shell doc 4): a docked pill above the mobile
// thumb-zone nav on < md, a corner pill on md+. Shows phase / countdown / round /
// bound task and pause·skip·stop controls. Rendered only while a session exists.
// The countdown digits update every second but are aria-hidden; a separate polite
// status region announces phase/round changes only (not every tick).
export function FocusTimer() {
	const { session, roundsPerLongBreak, cue, start, pause, skip, reset } =
		useFocusTimer();
	if (!session) return null;

	const label = phaseLabel(session.cycle);
	const remaining = session.running
		? session.endsAt != null
			? remainingSecFrom(session.endsAt, Date.now())
			: session.remainingSec
		: session.remainingSec;
	const roundText = m.focus_round_of({
		round: session.cycle.round,
		total: roundsPerLongBreak,
	});

	return (
		<section
			aria-label={m.focus_timer_region_aria()}
			data-testid="focus-timer"
			className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] z-40 rounded-xl border bg-background/95 p-3 shadow-lg supports-backdrop-filter:bg-background/85 supports-backdrop-filter:backdrop-blur md:inset-x-auto md:right-4 md:bottom-4 md:w-72"
		>
			{/* Phase/round announcement: changes only on transitions, so screen
			    readers get phase changes without a per-second flood. */}
			<p
				role="status"
				aria-live="polite"
				className="flex items-baseline justify-between gap-2"
			>
				<span className="text-sm font-medium" data-testid="focus-phase">
					{label}
				</span>
				<span
					className="text-xs text-muted-foreground"
					data-testid="focus-round"
				>
					{roundText}
				</span>
			</p>

			<div className="mt-1 flex items-center justify-between gap-3">
				<span
					aria-hidden="true"
					data-testid="focus-countdown"
					className="font-mono text-2xl tabular-nums"
				>
					{formatMMSS(remaining)}
				</span>
				{/* Non-motion-safe pulse dot: reduced-motion users get a static dot. */}
				{session.running && (
					<span
						aria-hidden="true"
						className="size-2 rounded-full bg-primary motion-safe:animate-pulse"
					/>
				)}
			</div>

			{session.boundTaskTitle && (
				<p
					className="mt-1 truncate text-xs text-muted-foreground"
					data-testid="focus-task"
				>
					{session.boundTaskTitle}
				</p>
			)}

			<div className="mt-2 flex items-center gap-1.5">
				{session.running ? (
					<Button
						size="sm"
						variant="outline"
						data-testid="focus-pause"
						onClick={pause}
					>
						<Pause /> {m.focus_pause_action()}
					</Button>
				) : (
					<Button size="sm" data-testid="focus-start" onClick={start}>
						<Play /> {m.focus_start_action()}
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					aria-label={m.focus_skip_aria()}
					data-testid="focus-skip"
					onClick={skip}
				>
					<SkipForward /> {m.focus_skip_action()}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label={m.focus_stop_aria()}
					data-testid="focus-stop"
					onClick={reset}
				>
					<RotateCcw /> {m.focus_stop_action()}
				</Button>
			</div>

			{cue && (
				<p
					role="status"
					aria-live="polite"
					data-testid="focus-cue"
					className="mt-2 text-xs font-medium text-primary"
				>
					{cue.text}
				</p>
			)}
		</section>
	);
}
