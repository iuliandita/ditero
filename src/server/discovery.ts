// User lookup powering invite-on-assign pickers. Never returns email addresses
// (only id/name/image). "email" mode: exact-email match only. "directory" mode:
// exact-email match plus a name/email prefix search restricted to users who share
// a workspace with the caller — never the whole instance.
import { and, eq, ilike, inArray, ne, or } from "drizzle-orm";
import type { AppEnv } from "../auth/membership-role.ts";
import { db as defaultDb } from "../db/client.ts";
import { membership, user } from "../db/schema.ts";

export type DiscoveryMode = "email" | "directory";

export function resolveDiscoveryMode(env: AppEnv): DiscoveryMode {
	return env.DITERO_DISCOVERY === "directory" ? "directory" : "email";
}

export type LookupResult = { id: string; name: string; image: string | null };

// Escape LIKE wildcards so a query of "a%" is a literal prefix, not a pattern.
function likePrefix(q: string): string {
	return `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function lookupUsers(
	query: string,
	callerId: string,
	database: typeof defaultDb = defaultDb,
	env: AppEnv = process.env,
): Promise<LookupResult[]> {
	const q = query.trim();
	if (!q) return [];
	const cols = { id: user.id, name: user.name, image: user.image };

	// Exact-email match is always allowed (both modes). Returns id/name/image only.
	const exact = await database
		.select(cols)
		.from(user)
		.where(eq(user.email, q))
		.limit(1);

	if (resolveDiscoveryMode(env) === "email") return exact;

	// Directory mode: additionally prefix-search co-workspace users only.
	const callerWorkspaces = await database
		.select({ workspaceId: membership.workspaceId })
		.from(membership)
		.where(eq(membership.userId, callerId));
	const workspaceIds = callerWorkspaces.map((r) => r.workspaceId);
	if (workspaceIds.length === 0) return exact;

	const coMembers = await database
		.selectDistinct(cols)
		.from(user)
		.innerJoin(membership, eq(membership.userId, user.id))
		.where(
			and(
				inArray(membership.workspaceId, workspaceIds),
				ne(user.id, callerId),
				or(ilike(user.name, likePrefix(q)), ilike(user.email, likePrefix(q))),
			),
		)
		.limit(20);

	const seen = new Set<string>();
	const merged: LookupResult[] = [];
	for (const row of [...exact, ...coMembers]) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		merged.push(row);
	}
	return merged;
}
