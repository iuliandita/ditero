import { m } from "../../paraglide/messages.js";

type ManagedZero = {
	userID?: string;
	mutate: unknown;
	close: () => Promise<void>;
};
type LocalMutation = { client: Promise<unknown> };
type RetirementStorage = {
	storageFailed: () => boolean;
	pendingMutations: () => Promise<number>;
};

type Entry = {
	zero: ManagedZero;
	commits: Set<Promise<void>>;
	onRetire: () => void;
	isCancelled: () => boolean;
	storage?: RetirementStorage;
	retiring: boolean;
	stopped: boolean;
	failed: boolean;
	completion?: Promise<void>;
};

const clients = new Set<Entry>();
const owners = new WeakMap<ManagedZero, Entry>();

export class ZeroRetirementError extends Error {
	constructor(cause: unknown) {
		super("Could not save pending Zero changes", { cause });
	}
}

export class ZeroRetirementBlockedError extends ZeroRetirementError {
	constructor(readonly count: number) {
		super(undefined);
	}
}

export function retirementErrorMessage(error: unknown): string {
	while (error instanceof ZeroRetirementError) {
		if (error instanceof ZeroRetirementBlockedError)
			return m.sync_retirement_blocked({ count: error.count });
		error = error.cause;
	}
	return m.sync_save_pending_failed();
}

function retire(entry: Entry, retry = false): Promise<void> {
	if (entry.completion && !(retry && entry.failed)) return entry.completion;
	entry.retiring = true;
	entry.failed = false;
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const completion = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	entry.completion = completion;
	let closeStarted = false;
	void (async () => {
		// Freeze dispatch before waiting, including edits accepted just before
		// storage failed. Reconnecting alone does not prove those edits reached the server.
		await Promise.all(entry.commits);
		if (entry.storage?.storageFailed()) {
			const pending = await entry.storage.pendingMutations();
			if (pending > 0) throw new ZeroRetirementBlockedError(pending);
		}
		closeStarted = true;
		await entry.zero.close();
		// Close may discover a storage failure during its own persistence barrier.
		// Keep auth refresh and sync observers alive until that barrier succeeds.
		if (!entry.stopped) {
			entry.onRetire();
			entry.stopped = true;
		}
	})().then(
		() => {
			clients.delete(entry);
			resolve();
		},
		(error: unknown) => {
			if (
				typeof error === "object" &&
				error !== null &&
				"pendingMutations" in error &&
				typeof error.pendingMutations === "number" &&
				Number.isSafeInteger(error.pendingMutations) &&
				error.pendingMutations > 0
			)
				error = new ZeroRetirementBlockedError(error.pendingMutations);
			entry.failed = true;
			if (!closeStarted || error instanceof ZeroRetirementBlockedError)
				entry.retiring = false;
			reject(error);
		},
	);
	return completion;
}

export function registerZeroClient(
	accountId: string,
	zero: ManagedZero,
	onRetire: () => void,
	isCancelled: () => boolean = () => false,
	storage?: RetirementStorage,
): { retire: () => Promise<void> } {
	if (zero.userID !== accountId)
		throw new Error("Zero client does not belong to this account");
	const entry: Entry = {
		zero,
		commits: new Set(),
		onRetire,
		isCancelled,
		storage,
		retiring: false,
		stopped: false,
		failed: false,
	};
	clients.add(entry);
	owners.set(zero, entry);
	const mutate = zero.mutate as (...args: unknown[]) => LocalMutation;
	const tracked = (...args: unknown[]) => {
		if (entry.retiring) {
			const failure = Promise.resolve({
				type: "error",
				error: { type: "zero", message: "Zero client is retiring" },
			});
			return { client: failure, server: failure };
		}
		const result = mutate(...args);
		// A failed local mutation never applied. Its caller reports that failure;
		// it must still settle before the client is closed.
		const commit = result.client.then(
			() => {},
			() => {},
		);
		entry.commits.add(commit);
		void commit.then(() => entry.commits.delete(commit));
		return result;
	};
	Object.assign(tracked, mutate);
	Object.defineProperty(zero, "mutate", { value: tracked, configurable: true });
	return { retire: () => retire(entry) };
}

export function isZeroClientOwnerActive(zero: ManagedZero): boolean {
	const entry = owners.get(zero);
	return entry !== undefined && !entry.isCancelled();
}

export function captureZeroClientOwner(): (() => boolean) | undefined {
	const entry = [...clients].find((client) => !client.isCancelled());
	return entry ? () => !entry.isCancelled() : undefined;
}

// Factory waits never retry failed persistence. Only a deliberate UI action
// may retry after the storage failure has been corrected.
export async function waitForZeroRetirements(): Promise<void> {
	try {
		await Promise.all(
			[...clients].flatMap((entry) =>
				entry.completion ? [entry.completion] : [],
			),
		);
	} catch (error) {
		throw new ZeroRetirementError(error);
	}
}

export async function createAfterZeroRetirement<T>(
	create: () => T,
	isCancelled: () => boolean,
): Promise<T | undefined> {
	await waitForZeroRetirements();
	if (isCancelled()) return undefined;
	return create();
}

export async function retireZeroClients({
	retryFailed = true,
}: {
	retryFailed?: boolean;
} = {}): Promise<void> {
	await Promise.all([...clients].map((entry) => retire(entry, retryFailed)));
}

export async function runAfterZeroRetirement<T>(
	action: () => Promise<T>,
): Promise<T> {
	try {
		await retireZeroClients();
	} catch (error) {
		throw new ZeroRetirementError(error);
	}
	return action();
}
