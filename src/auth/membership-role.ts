// Shared role lookup for the server-side sharing endpoints (invite create/accept,
// managed account, lookup). The Zero mutators do the same via zql; these run on
// the plain drizzle path where there is no Zero tx.
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "../db/client.ts";
import { membership } from "../db/schema.ts";

export type Role = "owner" | "admin" | "member" | "viewer";

// process.env-compatible shape accepted by the sharing endpoints' config helpers.
export type AppEnv = Record<string, string | undefined>;

export const ROLES = new Set<Role>(["owner", "admin", "member", "viewer"]);
export const ADMIN_ROLES = new Set<Role>(["owner", "admin"]);
export const WRITE_ROLES = new Set<Role>(["owner", "admin", "member"]);

type RoleDb = Pick<typeof defaultDb, "select">;

export async function roleInWorkspace(
	database: RoleDb,
	userId: string,
	workspaceId: string,
): Promise<Role | undefined> {
	const rows = await database
		.select({ role: membership.role })
		.from(membership)
		.where(
			and(
				eq(membership.userId, userId),
				eq(membership.workspaceId, workspaceId),
			),
		)
		.limit(1);
	return rows[0]?.role as Role | undefined;
}
