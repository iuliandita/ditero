import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { makeIDBName } from "../../../node_modules/@rocicorp/zero/out/replicache/src/make-idb-name.js";
import { ReplicacheImpl } from "../../../node_modules/@rocicorp/zero/out/replicache/src/replicache-impl.js";
import { findEarlierUnsyncedEdits } from "./earlier-edits.ts";

// Zero 1.9 stamped its databases 51.<schema hash>; 1.11 uses 52.<hash>.
async function earlierClient(name: string, edits: number) {
	const rep = new ReplicacheImpl(
		{
			name,
			schemaVersion: "51.earlier",
			kvStore: "idb",
			mutators: {
				write: async (tx: { set(key: string, value: string): Promise<void> }) =>
					await tx.set("edit", randomUUID()),
			},
			logSinks: [],
		},
		{
			enableScheduledPersist: false,
			enableScheduledRefresh: false,
			enableMutationRecovery: false,
			enablePullAndPushInOpen: false,
		},
	);
	for (let i = 0; i < edits; i++) await rep.mutate.write();
	await rep.persist();
	await rep.close();
	return rep.idbName;
}

async function listed() {
	return (await indexedDB.databases()).map((db) => db.name).sort();
}

it("finds unacknowledged edits left in an earlier database, read-only", async () => {
	const name = `zero-${randomUUID()}-key`;
	const earlier = await earlierClient(name, 2);
	const current = makeIDBName(name, "52.current");
	const before = await listed();
	expect(await findEarlierUnsyncedEdits(current)).toEqual([earlier]);
	expect(await listed()).toEqual(before);
	expect(before).not.toContain(current);
});

it("ignores drained databases, other accounts and scopes, and itself", async () => {
	const name = `zero-${randomUUID()}-key`;
	await earlierClient(name, 0);
	await earlierClient(`zero-${randomUUID()}-key`, 1);
	await earlierClient(`${name}x`, 1);
	expect(
		await findEarlierUnsyncedEdits(makeIDBName(name, "52.current")),
	).toEqual([]);
	const self = await earlierClient(`zero-${randomUUID()}-key`, 1);
	expect(await findEarlierUnsyncedEdits(self)).toEqual([]);
});
