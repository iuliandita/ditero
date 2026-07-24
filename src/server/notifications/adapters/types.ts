import type { ChannelKind } from "../../../domain/notification-channel.ts";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import type { safeFetch } from "../../../security/safe-http.ts";
import type { Network } from "../../client-ip.ts";
import type { Mailer } from "../../mail/transport.ts";

export type ChannelPayload = {
	title: string;
	body: string;
	urgent: boolean;
	ackUrl: string | null;
};

// The adapter receives its egress policy and its fetch explicitly (C16). A
// module-level env singleton would make the adapter untestable against an
// injected double.
//
// `signal` is the worker's: it owns the deadline and aborts in a finally, so an
// adapter that does not propagate it leaks the socket of every timed-out send.
// `deadlineMs` is a second, independent bound -- safeFetch's bodyTimeout only
// caps the gap between chunks, so a slow-drip server otherwise holds a worker
// slot indefinitely (C18) -- and gives a future non-HTTP adapter something to
// bound itself with.
// `mailer` is the same seam as `fetch`, for the one adapter whose transport is
// SMTP rather than HTTP. Unset means "resolve the operator-configured mailer",
// which is null on a deployment with no SMTP -- not an error the adapter has to
// be told about separately.
export type AdapterContext = {
	allowedPrivateCIDRs: readonly Network[];
	deadlineMs: number;
	signal: AbortSignal;
	fetch?: typeof safeFetch;
	mailer?: Mailer | null;
};

// `send` must never throw: the worker classifies a ProviderResult, and a
// rejection would be flattened into an untyped transport error that loses the
// permanent/retryable distinction.
export type ChannelAdapter = {
	kind: ChannelKind;
	send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult>;
};

// `policyRejected` is what makes classifyRetry return permanent. Shared so the
// adapters and the dispatch path cannot drift on how a never-deliverable send
// is reported. Note the resulting retry_class is "policy" for every cause,
// including plain misconfiguration; Task 17 splits the operator-facing label.
export function permanent(error: string): ProviderResult {
	return { ok: false, policyRejected: true, error };
}
