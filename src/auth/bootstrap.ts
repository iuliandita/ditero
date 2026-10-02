import { and, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { membership, workspace } from "../db/schema.ts";

type BootstrapUser = {
	id: string;
	name: string;
	email: string;
};

export async function ensurePersonalWorkspace(
	person: BootstrapUser,
	database: typeof db = db,
): Promise<string> {
	return database.transaction((tx) =>
		ensurePersonalWorkspaceInTransaction(person, tx),
	);
}

export async function ensurePersonalWorkspaceInTransaction(
	person: BootstrapUser,
	database: Pick<typeof db, "select" | "insert">,
): Promise<string> {
	const [existing] = await database
		.select({ id: workspace.id })
		.from(workspace)
		.where(
			and(eq(workspace.ownerId, person.id), eq(workspace.kind, "personal")),
		)
		.limit(1);

	let workspaceId = existing?.id;
	if (!workspaceId) {
		const [created] = await database
			.insert(workspace)
			.values({
				id: crypto.randomUUID(),
				name: `${person.name || person.email}'s space`,
				ownerId: person.id,
				kind: "personal",
			})
			.onConflictDoNothing()
			.returning({ id: workspace.id });
		workspaceId = created?.id;
	}

	if (!workspaceId) {
		const [concurrent] = await database
			.select({ id: workspace.id })
			.from(workspace)
			.where(
				and(eq(workspace.ownerId, person.id), eq(workspace.kind, "personal")),
			)
			.limit(1);
		workspaceId = concurrent?.id;
	}
	if (!workspaceId) throw new Error("personal workspace provisioning failed");

	await database
		.insert(membership)
		.values({
			id: crypto.randomUUID(),
			userId: person.id,
			workspaceId,
			role: "owner",
		})
		.onConflictDoNothing();
	return workspaceId;
}
