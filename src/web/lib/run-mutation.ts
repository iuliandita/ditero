import { m } from "../../paraglide/messages.js";
import { mutationErrorMessage } from "./mutator-messages.ts";

// Zero never rejects a mutation promise for a mutator throw: its mutator proxy
// resolves `.client` (and `.server`) with `{ type: "error", error: { message } }`
// instead. Returns that message ("" when absent), or null for a success.
export function mutationResultError(result: unknown): string | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as { type?: unknown; error?: { message?: unknown } };
	if (r.type !== "error") return null;
	return typeof r.error?.message === "string" ? r.error.message : "";
}

// Shared Zero-mutation runner for the list surfaces. Awaits the optimistic
// `.client` result and routes an error result to the caller's error state.
// mutationErrorMessage logs the raw error, so a swallowed mutator failure still
// surfaces in the console; only translated prose reaches the DOM.
export async function runMutation(
	mutation: { client: Promise<unknown> },
	onError: (message: string) => void,
): Promise<boolean> {
	const error = mutationResultError(await mutation.client);
	if (error === null) return true;
	onError(mutationErrorMessage(error, m.mutation_failed));
	return false;
}
