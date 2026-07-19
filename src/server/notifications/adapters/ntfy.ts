import {
	channelConfigSchema,
	redactChannelUrl,
} from "../../../domain/notification-channel.ts";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelPayload,
} from "./types.ts";

const TITLE_MAX = 200;
const BODY_MAX = 4_000;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const ACK_LABEL = "Done";

// Header values are single-line by definition: a CR/LF in a user-supplied title
// is a header-injection attempt that undici rejects outright, which would turn a
// badly-named task into a permanent delivery failure (C20). Other C0 controls go
// too -- they are invisible in a notification and only serve to smuggle intent.
function headerSafe(value: string, max: number): string {
	let out = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? " " : character;
	}
	return out.replace(/\s+/g, " ").trim().slice(0, max);
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

// The worker redacts again before persisting; doing it here too means a caller
// that only logs the ProviderResult still cannot leak a channel URL's
// credentials or query secrets.
function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : "unknown error";
	return message.replace(URL_IN_TEXT, redactChannelUrl);
}

// ntfy's Actions header is comma/semicolon delimited, so any value that could
// contain a delimiter is quoted, with `"` and `\` escaped.
function quoteAction(value: string): string {
	return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

function retryAfterSeconds(header: string | null): number | undefined {
	const raw = header?.trim();
	// Number("") is 0, which would ask for an immediate retry of a 429.
	if (!raw) return undefined;
	const seconds = Number(raw);
	// An HTTP-date form is legal here and is deliberately not parsed:
	// classifyRetry falls back to its own backoff when retryAfterSec is absent.
	return Number.isFinite(seconds) ? seconds : undefined;
}

function permanent(error: string): ProviderResult {
	return { ok: false, policyRejected: true, error };
}

function buildHeaders(
	payload: ChannelPayload,
	token: string | undefined,
): Headers {
	const headers = new Headers({
		"Content-Type": "text/plain; charset=utf-8",
		"X-Title": headerSafe(payload.title, TITLE_MAX),
	});
	if (payload.urgent) headers.set("Priority", "urgent");
	if (token) headers.set("Authorization", `Bearer ${token}`);
	if (payload.ackUrl) {
		headers.set(
			"Actions",
			`http, ${quoteAction(ACK_LABEL)}, ${payload.ackUrl}, method=POST, clear=true`,
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

		try {
			// Both bounds, not either: the worker's signal is what reaches the
			// socket when it stops waiting, and the timeout is what stops a
			// slow-drip response from holding the slot (C18).
			const response = await (ctx.fetch ?? safeFetch)(url, {
				method: "POST",
				headers: buildHeaders(payload, token),
				// The body is text/plain, not a header: newlines are legitimate there
				// and only the length needs bounding.
				body: payload.body.slice(0, BODY_MAX),
				signal: AbortSignal.any([
					ctx.signal,
					AbortSignal.timeout(ctx.deadlineMs),
				]),
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
		}
	},
};
