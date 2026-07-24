// The one channel adapter that speaks no HTTP. Everything outbound goes through
// the operator-configured SMTP transport (server/mail/transport.ts); there is
// deliberately no safeFetch import here, and the egress sweep in ntfy.test.ts
// holds this file to the stricter rule that it reaches no network primitive at
// all.
import { encodeHeaderValue, headerSafe } from "../../../domain/mime-header.ts";
import { channelConfigSchema } from "../../../domain/notification-channel.ts";
import type {
	ChannelErrorCode,
	ProviderResult,
} from "../../../domain/notification-retry.ts";
import { mailerFromEnv } from "../../mail/transport.ts";
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelPayload,
} from "./types.ts";
import { permanent } from "./types.ts";

const SUBJECT_MAX = 200;
const BODY_MAX = 4_000;
const ACK_LABEL = "Mark it done:";

// classifyRetry reads HTTP semantics, where 5xx retries and 4xx (bar 429) is
// final. SMTP is the other way round, so a permanent SMTP rejection has to be
// reported in the HTTP band that means "never again" -- otherwise a hard 550
// would be retried for the full 33-minute ladder against a mailbox that does
// not exist. The status also has to be one channelErrorCode maps back to the
// category the transport already determined.
// 400 and not 403 for the rest: channelErrorCode reads 403 as "auth", so a
// mailbox-full rejection would be reported to the user as a credential problem.
// rate_limited and transport are unreachable -- the transport only pairs them
// with retryable: true -- but the Record is exhaustive so a future category
// cannot be added without a status.
const PERMANENT_STATUS: Record<ChannelErrorCode, number> = {
	auth: 401,
	not_found: 404,
	rate_limited: 400,
	policy: 400,
	transport: 400,
};

function body(payload: ChannelPayload): string {
	const lines = [payload.title, "", payload.body];
	if (payload.ackUrl) lines.push("", `${ACK_LABEL} ${payload.ackUrl}`);
	return lines.join("\n").slice(0, BODY_MAX);
}

export const emailAdapter: ChannelAdapter = {
	kind: "email",
	async send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult> {
		const parsed = channelConfigSchema.email.safeParse(config);
		// A stored config that cannot be parsed will never parse on a retry.
		if (!parsed.success) return permanent("email: unusable channel config");
		const { address } = parsed.data as { address: string };

		// Not `??`: an explicit null is a caller stating "no mailer", and falling
		// through to the env-resolved one would send real mail from a test.
		const mailer = ctx.mailer === undefined ? mailerFromEnv() : ctx.mailer;
		// channels.ts refuses to save an email channel while SMTP is unconfigured,
		// so this is the operator having removed the config afterwards. Permanent:
		// no retry brings an SMTP server back.
		if (!mailer) {
			return permanent("email: SMTP is not configured on this deployment");
		}

		// Mail has no interactive callback, so the ack is a link in the body. The
		// title reaches the Subject header, which is where a CR/LF in a task name
		// would splice a header or a body -- and where a non-ASCII one needs an
		// RFC 2047 encoded-word. Same two rules the ntfy X-Title obeys, same
		// implementation.
		const subject = encodeHeaderValue(headerSafe(payload.title, SUBJECT_MAX));

		const result = await mailer.send(
			{ to: address, subject, text: body(payload), urgent: payload.urgent },
			{ signal: ctx.signal, deadlineMs: ctx.deadlineMs },
		);
		if (result.ok) return { ok: true, status: 250 };

		const { failure } = result;
		const code = failure.smtpCode === undefined ? "" : ` ${failure.smtpCode}`;
		// Never the server's reply text: it is remote free text and can quote back
		// the line that carried the SMTP credentials. The transport scrubs those
		// literally; this drops the text entirely.
		const error = `email${code}: ${failure.category}`;
		return failure.retryable
			? {
					ok: false,
					// A 4xx SMTP reply is "try again later", which is what 429 means
					// to classifyRetry; a connect-level failure carries no status at
					// all and lands in the transport class.
					...(failure.smtpCode === undefined ? {} : { status: 429 }),
					error,
				}
			: { ok: false, status: PERMANENT_STATUS[failure.category], error };
	},
};
