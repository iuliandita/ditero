import { Palmtree } from "lucide-react";
import type { ReactNode } from "react";
import { evaluateGoals, levelForPoints } from "../../../domain/karma.ts";
import { useKarma } from "../../hooks/useKarma.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { todayISO } from "../../lib/today.ts";
import { cn } from "../../lib/utils.ts";
import { KarmaLedger } from "./KarmaLedger.tsx";
import { levelProgress, ringFraction } from "./karma-format.ts";

// Static progress ring: pure SVG, no CSS transition, so it is already
// reduced-motion safe (renders the final fill on mount, per shell doc 5). The
// aria-label is the ring's text equivalent; the inner numerals are aria-hidden.
function Ring({
	fraction,
	label,
	met,
	children,
}: {
	fraction: number;
	label: string;
	met?: boolean;
	children: ReactNode;
}) {
	const r = 34;
	const c = 2 * Math.PI * r;
	const dash = c * Math.max(0, Math.min(1, fraction));
	return (
		<div
			role="img"
			aria-label={label}
			className="relative inline-flex size-24 items-center justify-center"
		>
			<svg
				viewBox="0 0 80 80"
				className="size-24 -rotate-90"
				aria-hidden="true"
			>
				<circle
					cx="40"
					cy="40"
					r={r}
					fill="none"
					strokeWidth="8"
					className="stroke-muted"
				/>
				<circle
					cx="40"
					cy="40"
					r={r}
					fill="none"
					strokeWidth="8"
					strokeLinecap="round"
					className={cn(met ? "stroke-success" : "stroke-primary")}
					strokeDasharray={`${dash} ${c}`}
				/>
			</svg>
			<span
				className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight"
				aria-hidden="true"
			>
				{children}
			</span>
		</div>
	);
}

// Own-user Progress panel (shell doc 5): a level ring, daily + weekly goal
// rings, a vacation note, and the transparent karma ledger. Own data only --
// no other user's karma is ever queried or shown (useKarma reads the caller's
// rows via the isolation-tested queries.karma.mine/karmaEvents.mine).
export function KarmaPanel() {
	const { karma, events, loading } = useKarma();
	const { pref } = useUserPref();
	const goals = pref.karmaGoals;
	const vacation = pref.vacation;

	const points = karma?.points ?? 0;
	const level = levelForPoints(points);
	const prog = levelProgress(points, level);

	const today = todayISO();
	const { dailyDone, weeklyDone, dailyMet, weeklyMet } = evaluateGoals(
		events,
		goals,
		today,
	);

	const levelLabel = prog.maxed
		? `Level ${level}, max level reached, ${points} points`
		: `Level ${level}, ${prog.into} of ${prog.span} points toward level ${
				level + 1
			}`;

	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="karma-heading"
			data-testid="karma-panel"
		>
			<div className="flex items-center justify-between gap-3">
				<h2 id="karma-heading" className="text-sm font-semibold">
					Progress
				</h2>
				{vacation.active && (
					<span
						data-testid="karma-vacation-badge"
						className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
					>
						<Palmtree className="size-3" aria-hidden="true" />
						Vacation
					</span>
				)}
			</div>

			{vacation.active && (
				<p
					className="mt-1 text-xs text-muted-foreground"
					data-testid="karma-vacation-note"
				>
					Vacation pauses streak breaks and goal penalties
					{vacation.until ? ` until ${vacation.until}` : ""}. It is a pause, not
					a cheat -- points are still only earned by real completions.
				</p>
			)}

			<div className="mt-4 flex flex-wrap items-start gap-6">
				<div className="flex flex-col items-center gap-1">
					<Ring fraction={prog.fraction} label={levelLabel} met={prog.maxed}>
						<span className="text-lg font-semibold">{level}</span>
						<span className="text-[10px] text-muted-foreground">
							{points} pts
						</span>
					</Ring>
					<span className="text-xs text-muted-foreground">
						{prog.maxed ? "Max level" : `Next: ${prog.next}`}
					</span>
				</div>

				<GoalRing
					title="Daily"
					done={dailyDone}
					goal={goals.daily}
					met={dailyMet}
				/>
				<GoalRing
					title="Weekly"
					done={weeklyDone}
					goal={goals.weekly}
					met={weeklyMet}
				/>
			</div>

			<h3 className="mt-6 mb-2 text-xs font-medium text-muted-foreground">
				Karma updates
			</h3>
			{loading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : (
				<KarmaLedger events={events} />
			)}
		</section>
	);
}

function GoalRing({
	title,
	done,
	goal,
	met,
}: {
	title: string;
	done: number;
	goal: number;
	met: boolean;
}) {
	const unset = goal <= 0;
	const label = unset
		? `${title} goal not set`
		: `${title} goal ${done} of ${goal}${met ? ", met" : ""}`;
	return (
		<div
			className="flex flex-col items-center gap-1"
			data-testid={`karma-goal-${title.toLowerCase()}`}
		>
			<Ring fraction={ringFraction(done, goal)} label={label} met={met}>
				{unset ? (
					<span className="text-xs text-muted-foreground">Not set</span>
				) : (
					<span className="text-sm font-semibold tabular-nums">
						{done}/{goal}
					</span>
				)}
			</Ring>
			<span className="text-xs text-muted-foreground">{title}</span>
		</div>
	);
}
