import { mutationResultError } from "./run-mutation.ts";

// A Zero mutation fails in one of two places: the optimistic client run throws,
// or the server refuses it. Zero reports both by resolving the promise with an
// error result, never by rejecting (see mutationResultError). Surfaces that
// confirm a write the moment it is made (the completion and move snackbars) use
// this to take the confirmation back. Fires at most once.
export function onMutationFailure(
	mutation: { client: Promise<unknown>; server: Promise<unknown> },
	onFail: () => void,
): void {
	let failed = false;
	const check = (result: unknown) => {
		if (failed || mutationResultError(result) === null) return;
		failed = true;
		onFail();
	};
	void mutation.client.then(check);
	void mutation.server.then(check);
}
