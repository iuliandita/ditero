// A Zero mutation fails in one of two places: the optimistic client run throws,
// or the server answers with something other than success (its promise
// resolves either way). Surfaces that confirm a write the moment it is made
// (the completion and move snackbars) use this to take the confirmation back.
// Fires at most once.
export function onMutationFailure(
	mutation: {
		client: Promise<unknown>;
		server: Promise<{ type: string }>;
	},
	onFail: () => void,
): void {
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		onFail();
	};
	mutation.client.catch(fail);
	mutation.server.then((result) => {
		if (result.type !== "success") fail();
	}, fail);
}
