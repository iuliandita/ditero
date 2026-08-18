// Guardian-provisioned managed ("kid") account. The guardian supplies a display
// name + password; we synthesize a non-routable @managed.invalid email as the
// sign-in handle. User creation is wrapped in withRegistrationBypass so it works
// even in closed/bootstrap mode. The kid is added to the guardian's workspace.
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.ts";
import { managedAccount, membership } from "../db/schema.ts";
import { ADMIN_ROLES, type Role, WRITE_ROLES } from "../domain/role.ts";
import { auth as defaultAuth } from "./auth.ts";
import {
	type AppEnv,
	memberInvitePolicy,
	roleInWorkspace,
} from "./membership-role.ts";
import { withRegistrationBypass } from "./registration-bypass.ts";

type RestrictedDb = Pick<typeof defaultDb, "select">;

// True when the user is a restricted managed ("kid") account. The kid model is a
// UI restriction over a normal membership, so this is the server backstop that
// denies restricted callers any invite/sub-account creation regardless of role.
export async function isRestrictedAccount(
	userId: string,
	database: RestrictedDb = defaultDb,
): Promise<boolean> {
	const rows = await database
		.select({ id: managedAccount.id })
		.from(managedAccount)
		.where(
			and(
				eq(managedAccount.userId, userId),
				eq(managedAccount.restricted, true),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export class ManagedAccountError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ManagedAccountError";
	}
}

export type CreateManagedAccountInput = {
	guardianId: string;
	workspaceId: string;
	displayName: string;
	password: string;
	role?: Role;
};

// A kid is never given elevated rights in the shared workspace.
const MANAGED_ROLES = new Set<Role>(["member", "viewer"]);

type AuthLike = Pick<typeof defaultAuth, "api">;

export async function createManagedAccount(
	input: CreateManagedAccountInput,
	database: typeof defaultDb = defaultDb,
	authInstance: AuthLike = defaultAuth,
	env: AppEnv = process.env,
): Promise<{ userId: string; email: string }> {
	const role: Role = input.role ?? "member";
	if (!MANAGED_ROLES.has(role)) {
		throw new ManagedAccountError(
			400,
			"managed account role must be member/viewer",
		);
	}
	if (!input.displayName.trim() || input.displayName.length > 100) {
		throw new ManagedAccountError(400, "displayName is required (max 100)");
	}
	if (input.password.length < 8 || input.password.length > 200) {
		throw new ManagedAccountError(400, "password must be 8-200 chars");
	}

	// A restricted account cannot provision sub-accounts (server backstop).
	if (await isRestrictedAccount(input.guardianId, database)) {
		throw new ManagedAccountError(
			403,
			"restricted accounts cannot create accounts",
		);
	}

	const guardianRole = await roleInWorkspace(
		database,
		input.guardianId,
		input.workspaceId,
	);
	if (!guardianRole) {
		throw new ManagedAccountError(403, "guardian is not a workspace member");
	}
	// Honor the same member-invite lever as createInvite: provisioning a kid drops a
	// new account into the shared workspace, so a strict ("admin") instance must not
	// let a plain member do it. Default policy allows member+.
	const allowed =
		memberInvitePolicy(env) === "admin"
			? ADMIN_ROLES.has(guardianRole)
			: WRITE_ROLES.has(guardianRole);
	if (!allowed) {
		throw new ManagedAccountError(
			403,
			"insufficient role to create a managed account",
		);
	}

	// RFC 6761 `.invalid` TLD: guaranteed non-resolvable, never deliverable.
	const email = `kid.${crypto.randomUUID()}@managed.invalid`;
	const result = await withRegistrationBypass(() =>
		authInstance.api.signUpEmail({
			body: { name: input.displayName, email, password: input.password },
		}),
	);
	const userId = result.user.id;

	// The auth `after` hook already gave the kid a personal workspace; here we add
	// the managed marker and the shared-workspace membership.
	await database.transaction(async (tx) => {
		await tx.insert(managedAccount).values({
			id: crypto.randomUUID(),
			userId,
			guardianId: input.guardianId,
			restricted: true,
		});
		await tx
			.insert(membership)
			.values({
				id: crypto.randomUUID(),
				userId,
				workspaceId: input.workspaceId,
				role,
			})
			.onConflictDoNothing();
	});

	return { userId, email };
}
