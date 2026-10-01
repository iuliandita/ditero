import { mutationResultFailure } from "./run-mutation.ts";

// Surfaces that confirm a write the moment it is made (the completion and
// move snackbars) use this to take the confirmation back when it did not hold.
// Fires at most once.
// - `.client` failing at all means the optimistic write never applied (a
//   mutator threw, or Zero was offline/closed).
// - `.server` counts only an application refusal. A connection drop settles
//   every outstanding `.server` with a "zero" error while the write stays
//   queued and succeeds on reconnect; that is not a failure to report.
export function onMutationFailure(
	mutation: { client: Promise<unknown>; server: Promise<unknown> },
	onFail: () => void,
): void {
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		onFail();
	};
	void mutation.client.then((result) => {
		if (mutationResultFailure(result) !== null) fail();
	});
	void mutation.server.then((result) => {
		if (mutationResultFailure(result)?.kind === "app") fail();
	});
}
