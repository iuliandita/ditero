import { randomId } from "../../domain/random-id.ts";

export type ExportSnapshot = {
	pending: number;
	uncertain: boolean;
	refused: boolean;
	prior: boolean;
	storageFailed: boolean;
};

type Mutation = { client: Promise<unknown>; server: Promise<unknown> };
type Outcome = "success" | "refusal" | "unknown";

function outcome(value: unknown): Outcome {
	if (typeof value !== "object" || value === null) return "unknown";
	const result = value as { type?: unknown; error?: unknown };
	if (result.type === "success" && Object.keys(value).length === 1)
		return "success";
	if (
		result.type !== "error" ||
		typeof result.error !== "object" ||
		result.error === null
	)
		return "unknown";
	const error = result.error as { type?: unknown; message?: unknown };
	return (error.type === "app" || error.type === "zero") &&
		typeof error.message === "string"
		? "refusal"
		: "unknown";
}

function browserStorage(): Storage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

// This journal records uncertainty only. It never inspects or clears Zero's queue.
export function createExportBoundary({
	userID,
	clientID,
	storage = browserStorage(),
	isConnected,
	generation = randomId(),
}: {
	userID: string;
	clientID: string;
	storage?: Storage;
	isConnected: () => boolean;
	generation?: string;
}) {
	const prefix = `ditero:export:v1:${encodeURIComponent(userID)}:`;
	const key = `${prefix}${encodeURIComponent(clientID)}:${encodeURIComponent(generation)}`;
	let snapshot: ExportSnapshot = {
		pending: 0,
		uncertain: false,
		refused: false,
		prior: false,
		storageFailed: !storage,
	};
	let retired = false;
	let inheritedOwn = false;
	const listeners = new Set<() => void>();
	const waits = new Set<() => void>();

	function publish(next: ExportSnapshot) {
		if (
			Object.keys(next).some(
				(field) =>
					next[field as keyof ExportSnapshot] !==
					snapshot[field as keyof ExportSnapshot],
			)
		) {
			snapshot = next;
			for (const listener of listeners) listener();
			for (const wake of waits) wake();
		}
	}

	function refreshJournal() {
		if (retired) return;
		let prior = inheritedOwn;
		try {
			if (!storage) throw new Error("Storage unavailable");
			for (let index = 0; index < storage.length; index++) {
				const storedKey = storage.key(index);
				if (storedKey?.startsWith(prefix) && storedKey !== key) prior = true;
			}
		} catch {
			publish({ ...snapshot, storageFailed: true });
			return;
		}
		publish({ ...snapshot, prior });
	}

	function record(next: ExportSnapshot) {
		try {
			if (!storage) throw new Error("Storage unavailable");
			if (next.pending || next.uncertain || next.refused || inheritedOwn)
				storage.setItem(
					key,
					JSON.stringify({
						pending: next.pending,
						uncertain: next.uncertain,
						refused: next.refused,
					}),
				);
			else storage.removeItem(key);
		} catch {
			next = { ...next, storageFailed: true };
		}
		publish(next);
	}

	try {
		inheritedOwn = storage?.getItem(key) !== null && storage !== undefined;
	} catch {
		snapshot = { ...snapshot, storageFailed: true };
	}
	refreshJournal();

	function blocked() {
		return (
			retired ||
			!isConnected() ||
			snapshot.uncertain ||
			snapshot.refused ||
			snapshot.prior ||
			snapshot.storageFailed
		);
	}

	return {
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			if (!retired) listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refreshJournal,
		connectionChanged() {
			for (const wake of waits) wake();
		},
		wrapMutation<T extends Mutation>(run: () => T): T {
			record({ ...snapshot, pending: snapshot.pending + 1 });
			let mutation: T;
			try {
				mutation = run();
			} catch (error) {
				record({ ...snapshot, pending: snapshot.pending - 1, uncertain: true });
				throw error;
			}
			// Attach both handlers now so even an early server rejection is observed.
			const server = mutation.server.then(
				(value) => value,
				() => undefined,
			);
			void mutation.client
				.then(
					(value) => outcome(value),
					() => "unknown" as const,
				)
				.then(async (client) => {
					if (retired) return;
					if (client === "refusal") {
						record({ ...snapshot, pending: snapshot.pending - 1 });
						return;
					}
					if (client === "unknown") {
						record({
							...snapshot,
							pending: snapshot.pending - 1,
							uncertain: true,
						});
						return;
					}
					const result = await server;
					if (retired) return;
					const status = outcome(result);
					const appRefusal =
						status === "refusal" &&
						(result as { error: { type: string } }).error.type === "app";
					record({
						...snapshot,
						pending: snapshot.pending - 1,
						refused: snapshot.refused || appRefusal,
						uncertain:
							snapshot.uncertain || (status !== "success" && !appRefusal),
					});
				});
			return mutation;
		},
		waitForSaved({
			signal,
			timeoutMs = 10_000,
		}: {
			signal: AbortSignal;
			timeoutMs?: number;
		}): Promise<boolean> {
			const deadline = Date.now() + Math.min(10_000, Math.max(0, timeoutMs));
			return new Promise((resolve) => {
				let timer: ReturnType<typeof setTimeout>;
				let finished = false;
				const finish = (saved: boolean) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					waits.delete(check);
					signal.removeEventListener("abort", check);
					resolve(saved);
				};
				const check = () => {
					if (finished) return;
					refreshJournal();
					if (signal.aborted || blocked() || Date.now() >= deadline)
						finish(false);
					else if (snapshot.pending === 0) finish(true);
				};
				timer = setTimeout(
					() => finish(false),
					Math.max(0, deadline - Date.now()),
				);
				signal.addEventListener("abort", check, { once: true });
				// Journal refresh can publish; register only after the initial check.
				check();
				if (!finished) waits.add(check);
			});
		},
		dispose() {
			retired = true;
			listeners.clear();
			for (const wake of waits) wake();
			waits.clear();
		},
	};
}

export type ExportBoundary = ReturnType<typeof createExportBoundary>;
