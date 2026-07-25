import { m } from "../../paraglide/messages.js";

// Shared Zero-mutation runner for the list surfaces. Awaits the optimistic
// `.client` promise and routes any rejection to the caller's error state, after
// logging it so a swallowed mutator failure still surfaces in the console.
export async function runMutation(
	mutation: { client: Promise<unknown> },
	onError: (message: string) => void,
): Promise<void> {
	try {
		await mutation.client;
	} catch (e) {
		console.error(e);
		onError(e instanceof Error ? e.message : m.mutation_failed());
	}
}
