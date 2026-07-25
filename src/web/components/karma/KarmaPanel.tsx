import { Palmtree } from "lucide-react";
import type { ReactNode } from "react";
import { evaluateGoals, levelForPoints } from "../../../domain/karma.ts";
import { localDay } from "../../../domain/local-day.ts";
import { m } from "../../../paraglide/messages.js";
import { useKarma } from "../../hooks/useKarma.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
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

	// The user's local day, the frame every karma_event date is written in.
	const today = localDay(new Date(), pref.timezone);
	const { dailyDone, weeklyDone, dailyMet, weeklyMet } = evaluateGoals(
		events,
		goals,
		today,
	);

	const levelLabel = prog.maxed
		? m.karma_level_maxed_aria({ level, points })
		: m.karma_level_progress_aria({
				level,
				into: prog.into,
				span: prog.span,
				next: level + 1,
			});

	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="karma-heading"
			data-testid="karma-panel"
		>
			<div className="flex items-center justify-between gap-3">
				<h2 id="karma-heading" className="text-sm font-semibold">
					{m.karma_panel_heading()}
				</h2>
				{vacation.active && (
					<span
						data-testid="karma-vacation-badge"
						className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
					>
						<Palmtree className="size-3" aria-hidden="true" />
						{m.karma_vacation_badge()}
					</span>
				)}
			</div>

			{vacation.active && (
				<p
					className="mt-1 text-xs text-muted-foreground"
					data-testid="karma-vacation-note"
				>
					{vacation.until
						? m.karma_vacation_panel_note_until({ date: vacation.until })
						: m.karma_vacation_panel_note()}
				</p>
			)}

			<div className="mt-4 flex flex-wrap items-start gap-6">
				<div className="flex flex-col items-center gap-1">
					<Ring fraction={prog.fraction} label={levelLabel} met={prog.maxed}>
						<span className="text-lg font-semibold">{level}</span>
						<span className="text-[10px] text-muted-foreground">
							{m.karma_points_short({ points })}
						</span>
					</Ring>
					<span className="text-xs text-muted-foreground">
						{prog.maxed
							? m.karma_level_max()
							: m.karma_level_next({ points: prog.next ?? 0 })}
					</span>
				</div>

				<GoalRing
					kind="daily"
					done={dailyDone}
					goal={goals.daily}
					met={dailyMet}
				/>
				<GoalRing
					kind="weekly"
					done={weeklyDone}
					goal={goals.weekly}
					met={weeklyMet}
				/>
			</div>

			<h3 className="mt-6 mb-2 text-xs font-medium text-muted-foreground">
				{m.karma_ledger_heading()}
			</h3>
			{loading ? (
				<p className="text-sm text-muted-foreground">
					{m.karma_ledger_loading()}
				</p>
			) : (
				<KarmaLedger events={events} />
			)}
		</section>
	);
}

type GoalKind = "daily" | "weekly";

// Whole aria sentences per goal, never "{translated title} goal ...": an
// inflected language cannot compose that. Thunks: module-scope locale freeze.
const GOAL_LABELS: Record<
	GoalKind,
	{
		title: () => string;
		unset: () => string;
		progress: (i: { done: number; goal: number }) => string;
		met: (i: { done: number; goal: number }) => string;
	}
> = {
	daily: {
		title: m.karma_goal_daily_title,
		unset: m.karma_goal_daily_unset_aria,
		progress: m.karma_goal_daily_aria,
		met: m.karma_goal_daily_met_aria,
	},
	weekly: {
		title: m.karma_goal_weekly_title,
		unset: m.karma_goal_weekly_unset_aria,
		progress: m.karma_goal_weekly_aria,
		met: m.karma_goal_weekly_met_aria,
	},
};

function GoalRing({
	kind,
	done,
	goal,
	met,
}: {
	kind: GoalKind;
	done: number;
	goal: number;
	met: boolean;
}) {
	const unset = goal <= 0;
	const msg = GOAL_LABELS[kind];
	const label = unset
		? msg.unset()
		: met
			? msg.met({ done, goal })
			: msg.progress({ done, goal });
	return (
		<div
			className="flex flex-col items-center gap-1"
			data-testid={`karma-goal-${kind}`}
		>
			<Ring fraction={ringFraction(done, goal)} label={label} met={met}>
				{unset ? (
					<span className="text-xs text-muted-foreground">
						{m.karma_goal_unset_value()}
					</span>
				) : (
					<span className="text-sm font-semibold tabular-nums">
						{done}/{goal}
					</span>
				)}
			</Ring>
			<span className="text-xs text-muted-foreground">{msg.title()}</span>
		</div>
	);
}
