// Guardian-provisioned managed ("kid") account. The guardian supplies a display
// name + password; we synthesize a non-routable @managed.invalid email as the
// sign-in handle. User creation is wrapped in withRegistrationBypass so it works
// even in closed/bootstrap mode. The kid is added to the guardian's workspace.
import { db as defaultDb } from "../db/client.ts";
import { managedAccount, membership } from "../db/schema.ts";
import { auth as defaultAuth } from "./auth.ts";
import { type Role, roleInWorkspace, WRITE_ROLES } from "./membership-role.ts";
import { withRegistrationBypass } from "./registration-bypass.ts";

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
): Promise<{ userId: string; email: string }> {
	const role: Role = input.role ?? "member";
	if (!MANAGED_ROLES.has(role)) {
		throw new ManagedAccountError(
			400,
			"managed account role must be member/viewer",
		);
	}
	if (!input.displayName.trim()) {
		throw new ManagedAccountError(400, "displayName is required");
	}
	if (!input.password) {
		throw new ManagedAccountError(400, "password is required");
	}

	const guardianRole = await roleInWorkspace(
		database,
		input.guardianId,
		input.workspaceId,
	);
	if (!guardianRole || !WRITE_ROLES.has(guardianRole)) {
		throw new ManagedAccountError(403, "guardian is not a workspace member");
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
