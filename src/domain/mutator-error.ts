// A mutator rejection the client can classify. The code rides in the message,
// not on the instance: a server-side rejection reaches the client as a plain
// string over the Zero push response, so a subclass field would survive only
// the optimistic path. The human prefix is kept verbatim so server logs and the
// integration suite's message regexes still read.

export const MUTATOR_ERROR_CODES = ["denied", "label_name_taken"] as const;

export type MutatorErrorCode = (typeof MUTATOR_ERROR_CODES)[number];

export class MutatorError extends Error {
	constructor(
		readonly code: MutatorErrorCode,
		reason: string,
	) {
		super(`${reason} [code:${code}]`);
		this.name = "MutatorError";
	}
}

const CODE_RE = /\[code:([a-z_]+)\]$/;

/** The code carried by a rejection, from either the local throw or the wire. */
export function mutatorErrorCode(e: unknown): MutatorErrorCode | null {
	const message =
		e instanceof Error ? e.message : typeof e === "string" ? e : "";
	const code = message.match(CODE_RE)?.[1];
	return code && (MUTATOR_ERROR_CODES as readonly string[]).includes(code)
		? (code as MutatorErrorCode)
		: null;
}
