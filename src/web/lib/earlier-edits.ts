// Zero keeps each client schema version in its own IndexedDB database. A new
// Zero protocol (1.9 to 1.11) or Ditero schema starts an empty one, and edits
// that never reached the server stay behind in the earlier one: Zero runs
// without mutation recovery, and its collector drops a database once its
// clients have been idle for two days. This only reads. It opens databases
// the browser already lists, so it never creates one, and writes nothing.
// The layout matches Zero's replicache format 7 (1.9 through 1.11): a
// databases registry, then per database a "client-groups" head whose chunk
// maps each client group to its local and server-acknowledged mutation IDs.
const REGISTRY = "replicache-dbs-v0";
const STORE = "chunks";
const FORMAT = 7;

type RegistryEntry = {
	name?: unknown;
	replicacheName?: unknown;
	replicacheFormatVersion?: unknown;
};
type ClientGroup = {
	mutationIDs?: Record<string, number>;
	lastServerAckdMutationIDs?: Record<string, number>;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = idb.open(name);
		// Listed databases never upgrade; if one vanished, do not recreate it.
		req.onupgradeneeded = () => {
			req.transaction?.abort();
			reject(new Error(`IndexedDB ${name} disappeared`));
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function read(db: IDBDatabase, keys: string[]): Promise<unknown[]> {
	const store = db.transaction(STORE, "readonly").objectStore(STORE);
	return Promise.all(keys.map((key) => request(store.get(key))));
}

// Mirrors Zero's clientGroupHasPendingMutations.
function hasPending(group: ClientGroup): boolean {
	const acked = group.lastServerAckdMutationIDs ?? {};
	return Object.entries(group.mutationIDs ?? {}).some(
		([client, id]) => id > (acked[client] ?? 0),
	);
}

async function databaseHasPending(
	idb: IDBFactory,
	name: string,
): Promise<boolean> {
	const db = await openExisting(idb, name);
	try {
		if (!db.objectStoreNames.contains(STORE)) return false;
		const [head] = await read(db, ["h/client-groups"]);
		if (typeof head !== "string") return false;
		const [groups] = await read(db, [`c/${head}/d`]);
		if (typeof groups !== "object" || groups === null) return false;
		return Object.values(groups as Record<string, ClientGroup>).some(
			hasPending,
		);
	} finally {
		db.close();
	}
}

// Names the other databases of this account and storage scope whose edits
// the server never acknowledged. `idbName` is the running Zero's database.
export async function findEarlierUnsyncedEdits(
	idbName: string,
	idb: IDBFactory = indexedDB,
): Promise<string[]> {
	const scope = /^rep:(.+):\d+:[^:]*$/.exec(idbName)?.[1];
	if (!scope) throw new Error(`Unexpected Zero database name ${idbName}`);
	const listed = new Set((await idb.databases()).map((db) => db.name));
	if (!listed.has(REGISTRY)) return [];
	const registry = await openExisting(idb, REGISTRY);
	let entries: RegistryEntry[];
	try {
		const [record] = await read(registry, ["dbs"]);
		entries = Object.values((record ?? {}) as Record<string, RegistryEntry>);
	} finally {
		registry.close();
	}
	const found: string[] = [];
	for (const entry of entries) {
		const name = entry.name;
		if (
			typeof name !== "string" ||
			name === idbName ||
			entry.replicacheName !== scope ||
			entry.replicacheFormatVersion !== FORMAT ||
			!listed.has(name)
		)
			continue;
		if (await databaseHasPending(idb, name)) found.push(name);
	}
	return found;
}
