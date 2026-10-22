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

export type EarlierEditsScan = {
	// Databases confirmed to hold edits the server never acknowledged.
	found: string[];
	// Some database could not be checked in time (blocked, hung, over the
	// candidate cap or unreadable), so `found` may be missing entries.
	incomplete: boolean;
};
export type EarlierEditsScanOptions = {
	idb?: IDBFactory;
	// Per IndexedDB request. A blocked open or a frozen tab must not hold the
	// scan, and the collector may delete the databases a few minutes in.
	requestTimeoutMs?: number;
	// Whole scan, across every database.
	totalTimeoutMs?: number;
	maxCandidates?: number;
};

const REQUEST_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES = 20;

class ScanTimeout extends Error {}

// Rejects when `ms` pass first. `onLate` receives a result that arrives after
// that, so a late successful open can still be closed.
function bounded<T>(
	start: (
		resolve: (value: T) => void,
		reject: (reason: unknown) => void,
	) => void,
	ms: number,
	onLate?: (value: T) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new ScanTimeout());
		}, ms);
		start(
			(value) => {
				if (settled) return onLate?.(value);
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			(reason) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(reason);
			},
		);
	});
}

function request<T>(req: IDBRequest<T>, ms: number): Promise<T> {
	return bounded<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	}, ms);
}

function openExisting(
	idb: IDBFactory,
	name: string,
	ms: number,
): Promise<IDBDatabase> {
	return bounded<IDBDatabase>(
		(resolve, reject) => {
			const req = idb.open(name);
			// Listed databases never upgrade; if one vanished, do not recreate it.
			req.onupgradeneeded = () => {
				req.transaction?.abort();
				reject(new Error(`IndexedDB ${name} disappeared`));
			};
			// Never queue behind another connection's version change or delete.
			req.onblocked = () => reject(new ScanTimeout());
			req.onsuccess = () => {
				const db = req.result;
				// Yield to any upgrade or delete (Zero's collector) at once.
				db.onversionchange = () => db.close();
				resolve(db);
			};
			req.onerror = () => reject(req.error);
		},
		ms,
		(db) => db.close(),
	);
}

async function read(
	db: IDBDatabase,
	keys: string[],
	ms: number,
): Promise<unknown[]> {
	const store = db.transaction(STORE, "readonly").objectStore(STORE);
	return Promise.all(keys.map((key) => request(store.get(key), ms)));
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
	ms: () => number,
): Promise<boolean> {
	const db = await openExisting(idb, name, ms());
	try {
		if (!db.objectStoreNames.contains(STORE)) return false;
		const [head] = await read(db, ["h/client-groups"], ms());
		if (typeof head !== "string") return false;
		const [groups] = await read(db, [`c/${head}/d`], ms());
		if (typeof groups !== "object" || groups === null) return false;
		return Object.values(groups as Record<string, ClientGroup>).some(
			hasPending,
		);
	} finally {
		db.close();
	}
}

// Checks the other databases of this account and storage scope for edits the
// server never acknowledged. `idbName` is the running Zero's database. Every
// request, the whole scan and the candidate count are bounded; whatever could
// not be checked sets `incomplete`. `onSnapshot` receives each new state as
// soon as it is known, so one blocked database never hides another's result.
export async function scanEarlierUnsyncedEdits(
	idbName: string,
	onSnapshot: (scan: EarlierEditsScan) => void,
	options: EarlierEditsScanOptions = {},
): Promise<EarlierEditsScan> {
	const scope = /^rep:(.+):\d+:[^:]*$/.exec(idbName)?.[1];
	if (!scope) throw new Error(`Unexpected Zero database name ${idbName}`);
	const {
		idb = indexedDB,
		requestTimeoutMs = REQUEST_TIMEOUT_MS,
		totalTimeoutMs = TOTAL_TIMEOUT_MS,
		maxCandidates = MAX_CANDIDATES,
	} = options;
	const deadline = Date.now() + totalTimeoutMs;
	const step = () =>
		Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()));
	const state: EarlierEditsScan = { found: [], incomplete: false };
	const publish = () =>
		onSnapshot({ found: [...state.found], incomplete: state.incomplete });
	const giveUp = () => {
		if (state.incomplete) return;
		state.incomplete = true;
		publish();
	};

	let entries: RegistryEntry[] = [];
	let listed: Set<string | undefined>;
	try {
		listed = new Set(
			(
				await bounded<IDBDatabaseInfo[]>(
					(resolve, reject) => idb.databases().then(resolve, reject),
					step(),
				)
			).map((db) => db.name),
		);
		if (listed.has(REGISTRY)) {
			const registry = await openExisting(idb, REGISTRY, step());
			try {
				const [record] = await read(registry, ["dbs"], step());
				entries = Object.values(
					(record ?? {}) as Record<string, RegistryEntry>,
				);
			} finally {
				registry.close();
			}
		}
	} catch {
		giveUp();
		return state;
	}
	const candidates = entries.flatMap((entry) =>
		typeof entry.name === "string" &&
		entry.name !== idbName &&
		entry.replicacheName === scope &&
		entry.replicacheFormatVersion === FORMAT &&
		listed.has(entry.name)
			? [entry.name]
			: [],
	);
	if (candidates.length > maxCandidates) giveUp();
	await Promise.all(
		candidates.slice(0, maxCandidates).map(async (name) => {
			try {
				if (await databaseHasPending(idb, name, step)) {
					state.found.push(name);
					publish();
				}
			} catch {
				giveUp();
			}
		}),
	);
	return state;
}

export async function findEarlierUnsyncedEdits(
	idbName: string,
	idb: IDBFactory = indexedDB,
): Promise<string[]> {
	return (await scanEarlierUnsyncedEdits(idbName, () => {}, { idb })).found;
}
