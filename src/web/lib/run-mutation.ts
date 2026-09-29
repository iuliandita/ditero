import { m } from "../../paraglide/messages.js";
import { mutationErrorMessage } from "./mutator-messages.ts";

// Zero never rejects a mutation promise: its mutator proxy resolves `.client`
// and `.server` with `{ type: "error", error: { type, message } }`. Zero 1.9's
// `error.type` separates the two causes that matter here:
// - "app": a mutator threw (client run) or the server refused the write;
// - "zero": Zero's own state. On `.client` that is the client being
//   disconnected, errored or closed, so the edit was NOT applied locally; on
//   `.server` it also covers a connection drop settling every outstanding
//   mutation while the write stays queued and lands on reconnect.
export type MutationFailure = { kind: "app" | "zero"; message: string };

export function mutationResultFailure(result: unknown): MutationFailure | null {
	if (typeof result !== "object" || result === null) return null;
	const r = result as {
		type?: unknown;
		error?: { type?: unknown; message?: unknown };
	};
	if (r.type !== "error") return null;
	return {
		kind: r.error?.type === "zero" ? "zero" : "app",
		message: typeof r.error?.message === "string" ? r.error.message : "",
	};
}

// A client-side "zero" failure means the change never applied: say so plainly
// rather than the generic failure, which reads as a refusal.
export function mutationFailureMessage(
	failure: MutationFailure,
	fallback: () => string,
): string {
	return failure.kind === "zero"
		? m.mutation_offline_not_saved()
		: mutationErrorMessage(failure.message, fallback);
}

// Shared Zero-mutation runner for the list surfaces. Awaits the optimistic
// `.client` result and routes a failure to the caller's error state.
// mutationErrorMessage logs the raw error, so a swallowed mutator failure still
// surfaces in the console; only translated prose reaches the DOM.
export async function runMutation(
	mutation: { client: Promise<unknown> },
	onError: (message: string) => void,
): Promise<boolean> {
	const failure = mutationResultFailure(await mutation.client);
	if (failure === null) return true;
	onError(mutationFailureMessage(failure, m.mutation_failed));
	return false;
}
