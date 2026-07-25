import { LEVEL_THRESHOLDS } from "../../../domain/karma.ts";
import { m } from "../../../paraglide/messages.js";

// karma_event.reason -> human label. The keys are the persisted reason values and
// are never translated. Thunks: module-scope locale freeze. Unknown reasons fall
// back to a humanized slug so a future reason never renders as a raw token.
const REASON_LABELS: Record<string, () => string> = {
	task_complete: m.karma_reason_task_complete,
	habit_done: m.karma_reason_habit_done,
	habit_undo: m.karma_reason_habit_undo,
	daily_goal: m.karma_reason_daily_goal,
	weekly_goal: m.karma_reason_weekly_goal,
	streak_bonus: m.karma_reason_streak_bonus,
};

function humanize(reason: string): string {
	const t = reason.replace(/[_-]+/g, " ").trim();
	return t ? t[0].toUpperCase() + t.slice(1) : m.karma_reason_fallback();
}

export function reasonLabel(reason: string): string {
	return Object.hasOwn(REASON_LABELS, reason)
		? REASON_LABELS[reason]()
		: humanize(reason);
}

// Fraction 0..1 of value toward goal; 0 when goal is unset (<= 0) so an unset
// goal never divides by zero.
export function ringFraction(value: number, goal: number): number {
	if (!Number.isFinite(goal) || goal <= 0) return 0;
	const f = value / goal;
	return f < 0 ? 0 : f > 1 ? 1 : f;
}

export type LevelProgress = {
	level: number;
	points: number;
	maxed: boolean;
	into: number; // points earned within the current level band
	span: number; // band width (next threshold - current threshold); 0 when maxed
	next: number | null; // next-level threshold, or null at max level
	fraction: number; // 0..1 within the band; 1 when maxed
};

// Band-relative progress for the level ring, so the ring fill and its aria label
// describe the same "into of span points toward the next level".
export function levelProgress(points: number, level: number): LevelProgress {
	const maxLevel = LEVEL_THRESHOLDS.length;
	const p = points < 0 ? 0 : points;
	if (level >= maxLevel) {
		return {
			level: maxLevel,
			points: p,
			maxed: true,
			into: 0,
			span: 0,
			next: null,
			fraction: 1,
		};
	}
	const base = LEVEL_THRESHOLDS[level - 1];
	const next = LEVEL_THRESHOLDS[level];
	const span = next - base;
	const into = p - base;
	const fraction = span > 0 ? Math.min(1, Math.max(0, into / span)) : 0;
	return { level, points: p, maxed: false, into, span, next, fraction };
}
