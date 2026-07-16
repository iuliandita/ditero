export const KARMA_POINTS = {
	task: 5,
	habit: 3,
	priorityBonus: [0, 1, 2, 4], // indexed by priority 0..3 (none/low/med/high)
} as const;

// Cumulative points required to REACH each level; index 0 => level 1 (0 points).
// Ten Todoist-inspired but independent tiers, monotonically increasing so an
// average day of a few completions steps a new user up quickly, then widens.
export const LEVEL_THRESHOLDS: number[] = [
	0, 50, 150, 300, 500, 800, 1200, 1800, 2600, 3600,
];

const clampPriority = (p: number): number =>
	p < 0 ? 0 : p > 3 ? 3 : Math.trunc(p);

export function karmaForCompletion(
	kind: "task" | "habit",
	priority: number,
): number {
	if (kind !== "task" && kind !== "habit") {
		throw new Error(`karma: unknown kind "${kind}"`);
	}
	const base = kind === "task" ? KARMA_POINTS.task : KARMA_POINTS.habit;
	return base + KARMA_POINTS.priorityBonus[clampPriority(priority)];
}

export function levelForPoints(points: number): number {
	if (points < 0) return 1;
	let level = 1;
	for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
		if (points >= LEVEL_THRESHOLDS[i]) level = i + 1;
		else break;
	}
	return level;
}

export type KarmaEvent = { date: string; delta: number; reason: string }; // date "YYYY-MM-DD"
export type KarmaGoals = { daily: number; weekly: number };

const toYMD = (d: Date): string => d.toISOString().slice(0, 10);

const parseYMD = (s: string): Date => {
	const [y, m, d] = s.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
};

const addDaysYMD = (s: string, n: number): string =>
	toYMD(new Date(parseYMD(s).getTime() + n * 86_400_000));

export function evaluateGoals(
	events: KarmaEvent[],
	goals: KarmaGoals,
	today: string, // "YYYY-MM-DD"
): {
	dailyDone: number;
	weeklyDone: number;
	dailyMet: boolean;
	weeklyMet: boolean;
} {
	const weekStart = addDaysYMD(today, -6);
	let dailyDone = 0;
	let weeklyDone = 0;
	for (const e of events) {
		if (e.delta <= 0) continue; // completions only; undo/compensation ignored
		if (e.date === today) dailyDone++;
		if (e.date >= weekStart && e.date <= today) weeklyDone++;
	}
	return {
		dailyDone,
		weeklyDone,
		dailyMet: dailyDone >= goals.daily,
		weeklyMet: weeklyDone >= goals.weekly,
	};
}
