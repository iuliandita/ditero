import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { makeIDBName } from "../../../node_modules/@rocicorp/zero/out/replicache/src/make-idb-name.js";
import { ReplicacheImpl } from "../../../node_modules/@rocicorp/zero/out/replicache/src/replicache-impl.js";
import {
	type EarlierEditsScan,
	findEarlierUnsyncedEdits,
	scanEarlierUnsyncedEdits,
} from "./earlier-edits.ts";

// Zero 1.9 stamped its databases 51.<schema hash>; 1.11 uses 52.<hash>.
async function earlierClient(
	name: string,
	edits: number,
	schemaVersion = "51.earlier",
) {
	const rep = new ReplicacheImpl(
		{
			name,
			schemaVersion,
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

afterEach(() => vi.restoreAllMocks());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = Symbol("never");
const within = <T>(ms: number, p: Promise<T>) =>
	Promise.race([p, sleep(ms).then(() => never)]);

function openAt(name: string, version?: number) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, version);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

// A connection that ignores versionchange plus a pending upgrade behind it:
// every later open of the database queues until `release`.
async function blockOpens(name: string) {
	const holder = await openAt(name);
	const upgrade = indexedDB.open(name, holder.version + 1);
	const upgraded = new Promise<IDBDatabase>((resolve) => {
		upgrade.onsuccess = () => resolve(upgrade.result);
	});
	return {
		async release() {
			holder.close();
			(await upgraded).close();
		},
	};
}

async function deleteIsBlocked(name: string) {
	return await new Promise<boolean>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onblocked = () => resolve(true);
		req.onsuccess = () => resolve(false);
	});
}

it("bounds a blocked open, keeps other results and closes it if it opens late", async () => {
	const name = `zero-${randomUUID()}-key`;
	const stuck = await earlierClient(name, 1, "51.a");
	const ok = await earlierClient(name, 1, "51.b");
	const closes: string[] = [];
	const close = IDBDatabase.prototype.close;
	vi.spyOn(IDBDatabase.prototype, "close").mockImplementation(function (
		this: IDBDatabase,
	) {
		closes.push(this.name);
		return close.call(this);
	});
	const blocker = await blockOpens(stuck);
	const snapshots: EarlierEditsScan[] = [];
	const started = Date.now();
	const scan = await scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		(s) => snapshots.push(s),
		{ requestTimeoutMs: 100, totalTimeoutMs: 5_000 },
	);
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(scan).toEqual({ found: [ok], incomplete: true });
	expect(snapshots.at(-1)).toEqual(scan);
	const before = closes.filter((n) => n === stuck).length;
	await blocker.release();
	await sleep(50);
	// The test closes the holder and the upgrader; the third close is the
	// scan's own connection that opened after it had given up.
	expect(closes.filter((n) => n === stuck).length - before).toBe(3);
});

it("publishes a finding while another database is still blocked", async () => {
	const name = `zero-${randomUUID()}-key`;
	const stuck = await earlierClient(name, 1, "51.a");
	const ok = await earlierClient(name, 1, "51.b");
	const blocker = await blockOpens(stuck);
	let announce: (s: EarlierEditsScan) => void = () => {};
	const first = new Promise<EarlierEditsScan>((r) => {
		announce = r;
	});
	const scan = scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		(s) => s.found.length > 0 && announce(s),
		{ requestTimeoutMs: 1_500, totalTimeoutMs: 5_000 },
	);
	expect(await within(500, first)).toEqual({ found: [ok], incomplete: false });
	expect((await scan).incomplete).toBe(true);
	await blocker.release();
});

it("stops at the whole-scan deadline, not the per-request one", async () => {
	const name = `zero-${randomUUID()}-key`;
	const stuck = await earlierClient(name, 1);
	const blocker = await blockOpens(stuck);
	const started = Date.now();
	const scan = await scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		() => {},
		{ requestTimeoutMs: 60_000, totalTimeoutMs: 150 },
	);
	expect(scan).toEqual({ found: [], incomplete: true });
	expect(Date.now() - started).toBeLessThan(2_000);
	await blocker.release();
});

it("reports incomplete when more databases exist than the candidate cap", async () => {
	const name = `zero-${randomUUID()}-key`;
	await earlierClient(name, 1, "51.a");
	await earlierClient(name, 1, "51.b");
	const scan = await scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		() => {},
		{ maxCandidates: 1 },
	);
	expect(scan.found).toHaveLength(1);
	expect(scan.incomplete).toBe(true);
});

it("gives up on an open that reports blocked without waiting for the timeout", async () => {
	const name = `zero-${randomUUID()}-key`;
	const earlier = await earlierClient(name, 1);
	const real = indexedDB;
	const idb = {
		databases: () => real.databases(),
		open: (dbName: string) => {
			if (dbName !== earlier) return real.open(dbName);
			const req = {} as IDBOpenDBRequest;
			queueMicrotask(() => req.onblocked?.(new Event("blocked") as never));
			return req;
		},
	} as unknown as IDBFactory;
	const started = Date.now();
	const scan = await scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		() => {},
		{ idb, requestTimeoutMs: 60_000, totalTimeoutMs: 60_000 },
	);
	expect(scan).toEqual({ found: [], incomplete: true });
	expect(Date.now() - started).toBeLessThan(2_000);
});

it("closes its connection when another tab upgrades or deletes the database", async () => {
	const name = `zero-${randomUUID()}-key`;
	const earlier = await earlierClient(name, 1);
	const get = IDBObjectStore.prototype.get;
	let stalled: () => void = () => {};
	const reading = new Promise<void>((r) => {
		stalled = r;
	});
	vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
		this: IDBObjectStore,
		key: IDBValidKey | IDBKeyRange,
	) {
		if (this.transaction.db.name !== earlier) return get.call(this, key);
		stalled();
		return {} as IDBRequest;
	});
	const scan = scanEarlierUnsyncedEdits(
		makeIDBName(name, "52.current"),
		() => {},
		{ requestTimeoutMs: 700, totalTimeoutMs: 5_000 },
	);
	await reading;
	expect(await within(500, deleteIsBlocked(earlier))).toBe(false);
	expect((await scan).incomplete).toBe(true);
});
