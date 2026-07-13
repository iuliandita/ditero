// Server-side invite creation. The token is generated here and returned ONCE over
// HTTP (never synced, never stored client-side). Role-escalation is the crown-jewel
// gate: a caller can only mint an invite for a role they are entitled to grant.
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.ts";
import { invite, list, task } from "../db/schema.ts";
import { newInviteToken } from "../domain/invite.ts";
import {
	ADMIN_ROLES,
	type AppEnv,
	ROLES,
	type Role,
	roleInWorkspace,
	WRITE_ROLES,
} from "./membership-role.ts";

export class InviteCreateError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "InviteCreateError";
	}
}

export type CreateInviteInput = {
	workspaceId: string;
	role: Role;
	email?: string | null;
	expiresAt?: number | null; // epoch ms
	maxUses?: number | null;
	attachTaskId?: string | null;
	attachKind?: "assign" | "mention" | null;
};

// Default "allow": member+ can invite member/viewer. "admin": only admin+ can
// invite anyone (tightens the member-invite lever for stricter instances).
export function memberInvitePolicy(env: AppEnv): "allow" | "admin" {
	return env.DITERO_MEMBER_INVITES === "admin" ? "admin" : "allow";
}

export function publicBaseUrl(env: AppEnv): string {
	return env.BETTER_AUTH_URL ?? `http://localhost:${env.API_PORT ?? 3000}`;
}

export function inviteLink(token: string, env: AppEnv): string {
	return `${publicBaseUrl(env)}/accept?token=${token}`;
}

export async function createInvite(
	input: CreateInviteInput,
	callerId: string,
	database: typeof defaultDb = defaultDb,
	env: AppEnv = process.env,
): Promise<{ id: string; token: string; link: string }> {
	if (!ROLES.has(input.role)) {
		throw new InviteCreateError(400, "invalid role");
	}
	// attachKind is set IFF attachTaskId is set.
	const hasTask = input.attachTaskId != null;
	const hasKind = input.attachKind != null;
	if (hasTask !== hasKind) {
		throw new InviteCreateError(
			400,
			"attachKind and attachTaskId must be set together",
		);
	}

	const callerRole = await roleInWorkspace(
		database,
		callerId,
		input.workspaceId,
	);
	if (!callerRole) throw new InviteCreateError(403, "not a workspace member");

	// Role-escalation gate, from most-privileged grant down:
	// - owner: only an owner may grant owner (workspace lifecycle/transfer); an
	//   admin must NOT be able to escalate an invitee past itself.
	// - admin: owner or admin (ADMIN_ROLES).
	// - member/viewer: member+ (WRITE_ROLES), unless policy tightens to admin+.
	let allowed: boolean;
	if (input.role === "owner") {
		allowed = callerRole === "owner";
	} else if (input.role === "admin") {
		allowed = ADMIN_ROLES.has(callerRole);
	} else {
		allowed =
			memberInvitePolicy(env) === "admin"
				? ADMIN_ROLES.has(callerRole)
				: WRITE_ROLES.has(callerRole);
	}
	if (!allowed) {
		throw new InviteCreateError(403, "insufficient role to grant this invite");
	}

	if (hasTask && input.attachTaskId) {
		// The attached task must live in the invite's workspace (no foreign attach).
		const rows = await database
			.select({ workspaceId: list.workspaceId })
			.from(task)
			.innerJoin(list, eq(task.listId, list.id))
			.where(eq(task.id, input.attachTaskId))
			.limit(1);
		const row = rows[0];
		if (!row) throw new InviteCreateError(400, "attach task not found");
		if (row.workspaceId !== input.workspaceId) {
			throw new InviteCreateError(400, "attach task not in workspace");
		}
	}

	const token = newInviteToken();
	const id = crypto.randomUUID();
	await database.insert(invite).values({
		id,
		workspaceId: input.workspaceId,
		role: input.role,
		email: input.email ?? null,
		token,
		status: "pending",
		uses: 0,
		expiresAt: input.expiresAt != null ? new Date(input.expiresAt) : null,
		maxUses: input.maxUses ?? null,
		attachTaskId: input.attachTaskId ?? null,
		attachKind: input.attachKind ?? null,
		createdBy: callerId,
	});

	return { id, token, link: inviteLink(token, env) };
}
