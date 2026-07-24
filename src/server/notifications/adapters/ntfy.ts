import { encodeHeaderValue, headerSafe } from "../../../domain/mime-header.ts";
import {
	channelConfigSchema,
	redactChannelUrl,
	redactUrlsIn,
} from "../../../domain/notification-channel.ts";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import { retryAfterSeconds } from "./retry-after.ts";
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelPayload,
} from "./types.ts";
import { permanent } from "./types.ts";

const TITLE_MAX = 200;
const BODY_MAX = 4_000;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const ACK_LABEL = "Done";

// The worker redacts again before persisting; doing it here too means a caller
// that only logs the ProviderResult still cannot leak a channel URL's
// credentials or query secrets.
function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "unknown error";
	return redactUrlsIn(message);
}

// ntfy's Actions header separates fields with commas and actions with
// semicolons, and documents that values containing either "may be quoted with
// double or single quotes". Every non-constant field is quoted, including the
// URL, whose origin comes from operator config.
function quoteAction(value: string): string {
	return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

function buildHeaders(
	payload: ChannelPayload,
	token: string | undefined,
): Headers {
	const headers = new Headers({
		"Content-Type": "text/plain; charset=utf-8",
		"X-Title": encodeHeaderValue(headerSafe(payload.title, TITLE_MAX)),
	});
	if (payload.urgent) headers.set("Priority", "urgent");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (payload.ackUrl) {
		headers.set(
			"Actions",
			`http, ${quoteAction(ACK_LABEL)}, ${quoteAction(payload.ackUrl)}, method=POST, clear=true`,
		);
	}
	return headers;
}

export const ntfyAdapter: ChannelAdapter = {
	kind: "ntfy",
	async send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult> {
		const parsed = channelConfigSchema.ntfy.safeParse(config);
		// A stored config that cannot be parsed will never parse on a retry.
		if (!parsed.success) return permanent("ntfy: unusable channel config");
		// channelConfigSchema is typed as ZodTypeAny (it is a total map over every
		// ChannelKind), so the narrowing the schema already guarantees is restated.
		const { serverUrl, topic, token } = parsed.data as {
			serverUrl: string;
			topic: string;
			token?: string;
		};
		const url = `${serverUrl.replace(/\/+$/, "")}/${topic}`;

		// Built outside the send's try/catch, and reported with no interpolated
		// message: a TypeError from Headers embeds the offending value, and here
		// that value can be the Authorization token. The charset regex in
		// ntfyConfigSchema should make this unreachable; this is the second half
		// of that guarantee, covering configs stored before the regex existed.
		let headers: Headers;
		try {
			headers = buildHeaders(payload, token);
		} catch {
			return permanent("ntfy: unusable channel config");
		}

		// Matches worker.ts's sendWithDeadline rather than introducing a second
		// idiom: AbortSignal.timeout holds its timer for the full deadline even
		// after a send that already completed.
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), ctx.deadlineMs);
		try {
			// Both bounds, not either: the worker's signal is what reaches the
			// socket when it stops waiting, and the deadline is what stops a
			// slow-drip response from holding the slot (C18).
			const response = await (ctx.fetch ?? safeFetch)(url, {
				method: "POST",
				headers,
				// The body is text/plain, not a header: newlines are legitimate there
				// and only the length needs bounding.
				body: payload.body.slice(0, BODY_MAX),
				signal: AbortSignal.any([ctx.signal, deadline.signal]),
				allowedPrivateCIDRs: ctx.allowedPrivateCIDRs,
				maxResponseBytes: RESPONSE_MAX_BYTES,
			});
			if (response.ok) return { ok: true, status: response.status };

			const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
			return {
				ok: false,
				status: response.status,
				...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }),
				// Never the response body, never the headers: the channel token
				// travels as Authorization and Task 8's redactor only handles URLs.
				error: `ntfy ${response.status} from ${redactChannelUrl(url)}`,
			};
		} catch (error) {
			if (error instanceof OutboundPolicyError) {
				return permanent(`ntfy: ${error.message}`);
			}
			return {
				ok: false,
				error: `ntfy: ${redactChannelUrl(url)} failed: ${safeMessage(error)}`,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};
