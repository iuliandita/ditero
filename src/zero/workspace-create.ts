import type { Transaction } from "@rocicorp/zero";
import type { WorkspaceCreateInput } from "../domain/workspace-create.ts";
import { type Schema, zql } from "./schema.gen.ts";
import { lockZeroPreferenceUser } from "./task-activation.ts";

type Tx = Transaction<Schema>;
type Row = Record<string, unknown>;

async function workspace(tx: Tx, id: string): Promise<Row | undefined> {
	if (tx.location !== "server")
		return await tx.run(zql.workspace.where("id", id).one());
	return Array.from(
		await tx.dbTransaction.query(
			`select id,name,kind,owner_id as "ownerId",rotation_required as "rotationRequired"
			 from workspace where id=$1`,
			[id],
		),
	)[0];
}

async function seat(tx: Tx, id: string): Promise<Row | undefined> {
	if (tx.location !== "server")
		return await tx.run(zql.membership.where("id", id).one());
	return Array.from(
		await tx.dbTransaction.query(
			`select id,user_id as "userId",workspace_id as "workspaceId",role
			 from membership where id=$1`,
			[id],
		),
	)[0];
}

function matchesWorkspace(
	row: Row | undefined,
	userId: string,
	args: WorkspaceCreateInput,
) {
	return (
		row?.id === args.id &&
		row.name === args.name &&
		row.kind === "shared" &&
		row.ownerId === userId
	);
}

function matchesSeat(
	row: Row | undefined,
	userId: string,
	args: WorkspaceCreateInput,
) {
	return (
		row?.id === args.membershipId &&
		row.userId === userId &&
		row.workspaceId === args.id &&
		row.role === "owner"
	);
}

function conflict(): never {
	throw new Error("Workspace creation conflicts with existing state");
}

async function uniqueSeat(tx: Tx, userId: string, args: WorkspaceCreateInput) {
	const rows =
		tx.location === "server"
			? Array.from(
					await tx.dbTransaction.query(
						"select id from membership where user_id=$1 and workspace_id=$2",
						[userId, args.id],
					),
				)
			: await tx.run(
					zql.membership.where("userId", userId).where("workspaceId", args.id),
				);
	return rows.length === 1 && rows[0]?.id === args.membershipId;
}

export async function createSharedWorkspace(
	tx: Tx,
	userId: string,
	args: WorkspaceCreateInput,
): Promise<void> {
	if (!userId)
		throw new Error("Workspace creation requires an authenticated user");
	await lockZeroPreferenceUser(tx, userId);
	if (tx.location === "server") {
		await tx.dbTransaction.query(
			"select pg_advisory_xact_lock(hashtextextended($1,0))",
			[`ditero:workspace-create:v1:${args.id}`],
		);
	}
	const existing = await workspace(tx, args.id);
	const existingSeat = await seat(tx, args.membershipId);
	if (existing) {
		if (
			!matchesWorkspace(existing, userId, args) ||
			!matchesSeat(existingSeat, userId, args) ||
			!(await uniqueSeat(tx, userId, args))
		)
			conflict();
		return;
	}
	if (existingSeat) conflict();
	await tx.mutate.workspace.insert({
		id: args.id,
		name: args.name,
		ownerId: userId,
		kind: "shared",
		rotationRequired: false,
	});
	// Zero inserts ignore primary-key conflicts; read authoritative rows before granting ownership.
	const created = await workspace(tx, args.id);
	if (
		!matchesWorkspace(created, userId, args) ||
		created?.rotationRequired !== false
	)
		conflict();
	await tx.mutate.membership.insert({
		id: args.membershipId,
		userId,
		workspaceId: args.id,
		role: "owner",
	});
	if (
		!matchesSeat(await seat(tx, args.membershipId), userId, args) ||
		!(await uniqueSeat(tx, userId, args))
	)
		conflict();
}
