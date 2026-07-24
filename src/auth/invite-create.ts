// Server-side invite creation. The token is generated here and returned ONCE over
// HTTP (never synced, never stored client-side). Role-escalation is the crown-jewel
// gate: a caller can only mint an invite for a role they are entitled to grant.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db as defaultDb } from "../db/client.ts";
import { invite, list, task } from "../db/schema.ts";
import { newInviteToken } from "../domain/invite.ts";
import { ackBaseUrl } from "../server/notifications/capability.ts";
import { isRestrictedAccount } from "./managed-account.ts";
import {
	ADMIN_ROLES,
	type AppEnv,
	memberInvitePolicy,
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

// ackBaseUrl is the codebase's single notion of a public origin
// (DITERO_PUBLIC_URL, then BETTER_AUTH_URL); this used to read BETTER_AUTH_URL
// alone, which was a second one. The localhost fallback stays for the returned
// copy-me link -- invite mail refuses to send without a real public URL rather
// than mailing an unusable one.
export function publicBaseUrl(env: AppEnv): string {
	return ackBaseUrl(env) ?? `http://localhost:${env.API_PORT ?? 3000}`;
}

export function inviteLink(token: string, env: AppEnv): string {
	return `${publicBaseUrl(env).replace(/\/+$/, "")}/accept?token=${encodeURIComponent(token)}`;
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

	// Server backstop: a restricted managed ("kid") account can mint no invites via
	// any path, regardless of its workspace role. Checked before the role gate.
	if (await isRestrictedAccount(callerId, database)) {
		throw new InviteCreateError(403, "restricted accounts cannot invite");
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
	// A targeted (email) invite is single-use by default: it should redeem once,
	// then acceptInvite flips it to 'accepted' so the owner's pending entry clears.
	// Open link/code invites (email null) stay reusable unless a cap is given.
	const email = input.email ?? null;
	// A targeted invite address must be a real, bounded email (RFC 5321 max 320).
	if (email != null && !z.string().email().max(320).safeParse(email).success) {
		throw new InviteCreateError(400, "invalid email");
	}
	const maxUses =
		input.maxUses !== undefined ? input.maxUses : email != null ? 1 : null;
	await database.insert(invite).values({
		id,
		workspaceId: input.workspaceId,
		role: input.role,
		email,
		token,
		status: "pending",
		uses: 0,
		expiresAt: input.expiresAt != null ? new Date(input.expiresAt) : null,
		maxUses,
		attachTaskId: input.attachTaskId ?? null,
		attachKind: input.attachKind ?? null,
		createdBy: callerId,
	});

	return { id, token, link: inviteLink(token, env) };
}
