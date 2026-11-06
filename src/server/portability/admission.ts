import type { Pool } from "pg";

export const PORTABILITY_CONCURRENCY = 3;
const admissions = new WeakMap<Pool, Set<string>>();
const connections = new WeakMap<Pool, Set<string>>();

function poolUsers(
	budgets: WeakMap<Pool, Set<string>>,
	pool: Pool,
): Set<string> {
	let users = budgets.get(pool);
	if (!users) {
		users = new Set();
		budgets.set(pool, users);
	}
	return users;
}

export function portabilityAdmission(pool: Pool): Set<string> {
	return poolUsers(admissions, pool);
}

export function acquirePortabilityConnection(
	pool: Pool,
	userId: string,
): (() => void) | null {
	const users = poolUsers(connections, pool);
	if (users.has(userId) || users.size >= PORTABILITY_CONCURRENCY) return null;
	users.add(userId);
	return () => {
		users.delete(userId);
	};
}
const planBudgets = new WeakMap<
	Set<string>,
	Map<string, { tokens: number; updatedAt: number }>
>();

export function takePlanCreationToken(
	admission: Set<string>,
	userId: string,
	now = performance.now(),
): boolean {
	let budgets = planBudgets.get(admission);
	if (!budgets) {
		budgets = new Map();
		planBudgets.set(admission, budgets);
	}
	for (const [id, budget] of budgets)
		if (now - budget.updatedAt >= 60_000) budgets.delete(id);
	const previous = budgets.get(userId);
	if (!previous && budgets.size >= 10_000) return false;
	const tokens = Math.min(
		4,
		(previous?.tokens ?? 4) + (now - (previous?.updatedAt ?? now)) / 15_000,
	);
	if (tokens < 1) return false;
	budgets.set(userId, { tokens: tokens - 1, updatedAt: now });
	return true;
}
