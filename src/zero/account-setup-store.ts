import type { Transaction } from "@rocicorp/zero";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import {
	type AccountSetupState,
	accountSetupSelection,
	accountSetupStateSchema,
} from "../domain/account-setup.ts";
import type { AccountSetupContent } from "../domain/account-setup-content.ts";
import {
	type AccountSetupGeneratedIds,
	accountSetupGeneratedIdsSchema,
	accountSetupStoredStateSchema,
} from "../domain/account-setup-storage.ts";
import { panelsSchema } from "../domain/dashboard.ts";
import { randomId } from "../domain/random-id.ts";
import type { Schema } from "./schema.gen.ts";
import { lockZeroPreferenceUser } from "./task-activation.ts";

type Tx = Transaction<Schema>;
const uuid = z.string().uuid().max(64);
function server(tx: Tx) {
	if (tx.location !== "server")
		throw new Error("account-setup: server transaction required");
	return tx.dbTransaction;
}
function revision(value: unknown): number {
	if (
		typeof value !== "number" &&
		typeof value !== "bigint" &&
		!(typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/.test(value))
	)
		throw new Error("account-setup: invalid revision");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error("account-setup: invalid revision");
	return parsed;
}
async function person(tx: Tx, actorId: string) {
	const rows = Array.from(
		await server(tx).query(
			'select id,email,name from "user" where id=$1 and deleted_at is null for update',
			[actorId],
		),
	);
	const row = rows[0];
	if (
		rows.length !== 1 ||
		row.id !== actorId ||
		typeof row.email !== "string" ||
		typeof row.name !== "string"
	)
		throw new Error("account-setup: inactive user");
	const managed = Array.from(
		await server(tx).query("select id from managed_account where user_id=$1", [
			actorId,
		]),
	);
	if (
		managed.length ||
		row.email.trim().toLowerCase().split("@").at(-1) === "managed.invalid"
	)
		throw new Error("account-setup: managed account");
	return { name: row.name, email: row.email };
}
export async function lockAccountSetupState(
	tx: Tx,
	actorId: string,
): Promise<AccountSetupState> {
	server(tx);
	await lockZeroPreferenceUser(tx, actorId);
	await person(tx, actorId);
	await server(tx).query(
		"insert into account_setup(id,outcome,revision) values($1,'pending',0) on conflict(id) do nothing",
		[actorId],
	);
	const rows = Array.from(
		await server(tx).query(
			"select outcome,revision,latest_receipt,catalog_version,locale,generated_ids from account_setup where id=$1 for update",
			[actorId],
		),
	);
	if (rows.length !== 1) throw new Error("account-setup: state missing");
	return accountSetupStoredStateSchema.parse({
		state: {
			outcome: rows[0].outcome,
			revision: revision(rows[0].revision),
			receipt: rows[0].latest_receipt,
		},
		catalogVersion: rows[0].catalog_version,
		locale: rows[0].locale,
		generatedIds: rows[0].generated_ids,
	}).state;
}
// Call only after a commit transition; replay must not repair or recreate content.
export async function ensureAccountSetupWorkspace(
	tx: Tx,
	actorId: string,
): Promise<string> {
	const user = await person(tx, actorId);
	const select = () =>
		server(tx).query(
			"select id from workspace where owner_id=$1 and kind='personal' for update",
			[actorId],
		);
	let rows = Array.from(await select());
	if (!rows.length) {
		await server(tx).query(
			"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,'personal') on conflict(owner_id) where kind='personal' do nothing returning id",
			[randomId(), `${user.name || user.email}'s space`, actorId],
		);
		rows = Array.from(await select());
	}
	if (rows.length !== 1)
		throw new Error("account-setup: personal workspace conflict");
	const workspaceId = uuid.parse(rows[0].id);
	await server(tx).query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner') on conflict(user_id,workspace_id) do nothing",
		[randomId(), actorId, workspaceId],
	);
	const seats = Array.from(
		await server(tx).query(
			"select role from membership where user_id=$1 and workspace_id=$2 for update",
			[actorId, workspaceId],
		),
	);
	if (seats.length !== 1 || seats[0].role !== "owner")
		throw new Error("account-setup: personal owner seat conflict");
	return workspaceId;
}
export async function commitAccountSetupState(
	tx: Tx,
	actorId: string,
	previousRevision: number,
	nextState: AccountSetupState,
	generatedIds: AccountSetupGeneratedIds | null,
): Promise<void> {
	const previous = revision(previousRevision);
	const next = accountSetupStateSchema.parse(nextState);
	if (
		!next.receipt ||
		next.revision !== previous + 1 ||
		next.receipt.request.expectedRevision !== previous
	)
		throw new Error("account-setup: invalid commit transition");
	const generated =
		generatedIds === null
			? null
			: accountSetupGeneratedIdsSchema.parse(generatedIds);
	if (next.outcome === "completed") {
		if (!generated) throw new Error("account-setup: content receipt missing");
		const selected = accountSetupSelection(next.receipt.request);
		if (
			generated.listIds.length !== selected.starterKeys.length ||
			generated.taskIds.length !== selected.starterKeys.length * 8 ||
			generated.panelIds.length !== (selected.dashboard ? 2 : 0) ||
			Boolean(generated.dashboardId) !== selected.dashboard
		)
			throw new Error("account-setup: content receipt mismatch");
	} else if (generated !== null)
		throw new Error("account-setup: empty choice content receipt");
	const rows = Array.from(
		await server(tx).query(
			"update account_setup set outcome=$3,revision=$4,catalog_version=$5,locale=$6,latest_receipt=$7::jsonb,generated_ids=$8::jsonb,updated_at=now() where id=$1 and revision=$2 returning id",
			[
				actorId,
				previous,
				next.outcome,
				next.revision,
				next.receipt.request.catalogVersion,
				next.receipt.request.locale,
				JSON.stringify(next.receipt),
				generated === null ? null : JSON.stringify(generated),
			],
		),
	);
	if (rows.length !== 1 || rows[0].id !== actorId)
		throw new Error("account-setup: revision conflict");
}

// Strict INSERTs intentionally propagate any existing ID collision to the outer transaction.
export async function insertAccountSetupContent(
	tx: Tx,
	actorId: string,
	workspaceId: string,
	content: AccountSetupContent,
): Promise<void> {
	const actor = z.string().min(1).max(256).parse(actorId);
	const workspace = uuid.parse(workspaceId);
	const title = z.string().min(1).max(120);
	const key = z.string().min(1).max(256);
	const lists = z
		.array(
			z
				.object({
					id: uuid,
					title,
					kind: z.enum(["shopping", "checklist", "tasks"]),
					sortKey: key,
					icon: z.string().min(1).max(80).optional(),
				})
				.strict(),
		)
		.max(3)
		.parse(content.lists);
	const tasks = z
		.array(
			z
				.object({
					id: uuid,
					listId: uuid,
					title,
					sortKey: key,
					done: z.literal(false),
					priority: z.number().int().min(1).max(3).optional(),
					category: z.string().min(1).max(60).optional(),
				})
				.strict(),
		)
		.max(24)
		.parse(content.tasks);
	const dashboard =
		content.dashboard === null
			? null
			: z
					.object({ id: uuid, title, workspaceId: uuid, panels: panelsSchema })
					.strict()
					.parse(content.dashboard);
	const receiptIds = z
		.object({
			listIds: z.array(uuid).max(3),
			taskIds: z.array(uuid).max(24),
			panelIds: z.array(uuid).max(2),
			dashboardId: uuid.nullable(),
		})
		.strict()
		.parse(content.generatedIds);
	const generated = accountSetupGeneratedIdsSchema.parse({
		version: 1,
		workspaceId: workspace,
		...receiptIds,
	});
	if (
		JSON.stringify(generated.listIds) !==
			JSON.stringify(lists.map((list) => list.id)) ||
		JSON.stringify(generated.taskIds) !==
			JSON.stringify(tasks.map((task) => task.id)) ||
		generated.dashboardId !== (dashboard?.id ?? null) ||
		JSON.stringify(generated.panelIds) !==
			JSON.stringify(dashboard?.panels.map((panel) => panel.id) ?? [])
	)
		throw new Error("account-setup: generated content mismatch");
	if (
		tasks.some((task) => !lists.some((list) => list.id === task.listId)) ||
		lists.some(
			(list) => tasks.filter((task) => task.listId === list.id).length !== 8,
		)
	)
		throw new Error("account-setup: task list mismatch");
	if (dashboard) {
		if (dashboard.workspaceId !== workspace || dashboard.panels.length !== 2)
			throw new Error("account-setup: dashboard scope mismatch");
		for (const [index, panel] of dashboard.panels.entries()) {
			const expectedType = index === 0 ? "tasks" : "counter";
			if (
				panel.type !== expectedType ||
				panel.size !== "l" ||
				!("source" in panel) ||
				panel.source.kind !== "inline" ||
				panel.source.workspaceScope.mode !== "one" ||
				panel.source.workspaceScope.id !== workspace ||
				panel.source.sort.field !== "due" ||
				panel.source.sort.dir !== "asc" ||
				panel.source.filter.op !== "and" ||
				panel.source.filter.conditions.length !== 1 ||
				(panel.type === "tasks" && panel.limit !== 10)
			)
				throw new Error("account-setup: dashboard panel mismatch");
			const condition = panel.source.filter.conditions[0];
			if (
				!("field" in condition) ||
				condition.field !== (index === 0 ? "done" : "due") ||
				condition.operator !== "is" ||
				condition.value !== (index === 0 ? false : "overdue")
			)
				throw new Error("account-setup: dashboard filter mismatch");
		}
	}
	const context = Array.from(
		await server(tx).query(
			"select current_setting('ditero.user_id',true) as actor",
			[],
		),
	);
	if (context.length !== 1 || context[0].actor !== actor)
		throw new Error("account-setup: caller context mismatch");
	const owned = Array.from(
		await server(tx).query(
			"select w.id from workspace w join membership m on m.workspace_id=w.id and m.user_id=$1 where w.id=$2 and w.owner_id=$1 and w.kind='personal' and m.role='owner' for update of w,m",
			[actor, workspace],
		),
	);
	if (owned.length !== 1 || owned[0].id !== workspace)
		throw new Error("account-setup: personal workspace authority missing");
	for (const list of lists)
		await server(tx).query(
			"insert into list(id,workspace_id,owner_id,title,kind,icon,sort_key,completed_display) values($1,$2,$3,$4,$5,$6,$7,'sink')",
			[
				list.id,
				workspace,
				actor,
				list.title,
				list.kind,
				list.icon ?? null,
				list.sortKey,
			],
		);
	for (const task of tasks)
		await server(tx).query(
			"insert into task(id,list_id,title,sort_key,done,has_import_activation,priority,category,created_at) values($1,$2,$3,$4,false,false,$5,$6,now())",
			[
				task.id,
				task.listId,
				task.title,
				task.sortKey,
				task.priority ?? 0,
				task.category ?? null,
			],
		);
	if (dashboard)
		await server(tx).query(
			"insert into dashboard(id,owner_id,workspace_id,scope,name,panels,sort_key) values($1,$2,null,'personal',$3,$4::jsonb,$5)",
			[
				dashboard.id,
				actor,
				dashboard.title,
				JSON.stringify(dashboard.panels),
				generateKeyBetween(null, null),
			],
		);
}
