import { onMutationFailure } from "./mutation-outcome.ts";

type Mutation = { client: Promise<unknown>; server: Promise<unknown> };

// Runs one mutation per item and collects the ids whose write failed. The set
// fills as answers arrive, so an Undo that reads it later takes back only the
// writes that held. `onFailure` gets the running count for the report.
export function runBatch<T extends { id: string }>(
	items: readonly T[],
	mutate: (item: T) => Mutation,
	run: (mutation: Mutation) => unknown,
	onFailure: (count: number) => void,
): ReadonlySet<string> {
	const failures = new Set<string>();
	for (const item of items) {
		const mutation = mutate(item);
		run(mutation);
		onMutationFailure(mutation, () => {
			failures.add(item.id);
			onFailure(failures.size);
		});
	}
	return failures;
}
