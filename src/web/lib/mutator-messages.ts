// Translate a mutator rejection. Same shape as channel-messages.ts: a closed
// code -> thunk map read through Object.hasOwn, since the code arrives inside a
// string that may have crossed the wire. An unclassified rejection never
// reaches the DOM -- the caller's translated fallback does, and the raw error
// goes to the console instead.
import {
	type MutatorErrorCode,
	mutatorErrorCode,
} from "../../domain/mutator-error.ts";
import { m } from "../../paraglide/messages.js";

const MUTATOR_ERROR_MESSAGES: Record<MutatorErrorCode, () => string> = {
	denied: m.mutator_error_denied,
	workspace_last_owner: m.workspace_leave_last_owner,
	workspace_personal_leave: m.workspace_leave_personal,
	label_name_taken: m.mutator_error_label_name_taken,
};

export function mutationErrorMessage(
	e: unknown,
	fallback: () => string,
): string {
	const code = mutatorErrorCode(e);
	if (code && Object.hasOwn(MUTATOR_ERROR_MESSAGES, code))
		return MUTATOR_ERROR_MESSAGES[code]();
	console.error(e);
	return fallback();
}
