type ManagedZero = {
	userID?: string;
	mutate: unknown;
	close: () => Promise<void>;
};
type LocalMutation = { client: Promise<unknown> };

type Entry = {
	zero: ManagedZero;
	commits: Set<Promise<void>>;
	onRetire: () => void;
	isCancelled: () => boolean;
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
	void (async () => {
		if (!entry.stopped) {
			entry.onRetire();
			entry.stopped = true;
		}
		// Only local commits matter here: server acknowledgments can wait until
		// this account reconnects, but accepted edits must reach durable storage.
		await Promise.all(entry.commits);
		await entry.zero.close();
	})().then(
		() => {
			clients.delete(entry);
			resolve();
		},
		(error: unknown) => {
			entry.failed = true;
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
): { retire: () => Promise<void> } {
	if (zero.userID !== accountId)
		throw new Error("Zero client does not belong to this account");
	const entry: Entry = {
		zero,
		commits: new Set(),
		onRetire,
		isCancelled,
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
