// Shared role lookup for the server-side sharing endpoints (invite create/accept,
// managed account, lookup). The Zero mutators do the same via zql; these run on
// the plain drizzle path where there is no Zero tx. The role ladder itself lives
// in domain/role.ts -- this module must never be imported from the client, since
// it pulls in drizzle and the db client.
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "../db/client.ts";
import { membership } from "../db/schema.ts";
import type { Role } from "../domain/role.ts";

// process.env-compatible shape accepted by the sharing endpoints' config helpers.
export type AppEnv = Record<string, string | undefined>;

// Default "allow": member+ can invite member/viewer (and provision managed kids).
// "admin": only admin+ can, tightening the member lever for stricter instances.
// NOTE: the invite set is deliberately NOT WRITE_ROLES -- it is member+ only
// while this returns "allow", and admin+ otherwise.
export function memberInvitePolicy(env: AppEnv): "allow" | "admin" {
	return env.DITERO_MEMBER_INVITES === "admin" ? "admin" : "allow";
}

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
