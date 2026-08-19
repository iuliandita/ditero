import { m } from "../../paraglide/messages.js";
import { mutationErrorMessage } from "./mutator-messages.ts";

// Shared Zero-mutation runner for the list surfaces. Awaits the optimistic
// `.client` promise and routes any rejection to the caller's error state.
// mutationErrorMessage logs the raw error, so a swallowed mutator failure still
// surfaces in the console; only translated prose reaches the DOM.
export async function runMutation(
	mutation: { client: Promise<unknown> },
	onError: (message: string) => void,
): Promise<void> {
	try {
		await mutation.client;
	} catch (e) {
		onError(mutationErrorMessage(e, m.mutation_failed));
	}
}
