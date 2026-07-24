// Invite mail. Until this existed an invite could only reach someone the
// inviter already contacted out-of-band, which is what M1b's invite-on-assign
// and invite-on-mention flows assume away.
//
// The recipient is an UNVERIFIED third party: nothing here reads a task, a list
// or a member, and the attach (attachTaskId/attachKind) is deliberately not an
// input. Two workspace-derived values reach the message. The workspace name is
// already public to any unauthenticated holder of the token -- previewInvite
// returns it, and the mail carries that token. The inviter's display name is
// not, and is disclosed deliberately: an unattributed invitation is
// indistinguishable from spam. The invitee's role is NOT included, matching
// previewInvite, which withholds it.
import { eq } from "drizzle-orm";
import type { db as defaultDb } from "../../db/client.ts";
import { user, workspace } from "../../db/schema.ts";
import type { InviteMailStatus } from "../../domain/invite.ts";
import { mailableAddress } from "../../domain/mail-address.ts";
import { encodeHeaderValue, headerSafe } from "../../domain/mime-header.ts";
import { ackBaseUrl } from "../notifications/capability.ts";
import { m } from "./invite-mail-messages.ts";
import type { Mailer } from "./transport.ts";
import { mailerFromEnv } from "./transport.ts";

const NAME_MAX = 120;
const SUBJECT_MAX = 200;

// The inviter's request is waiting on this send: the status has to be reported,
// so it cannot be detached the way auth mail is. Bounded well under the
// transport's 15s default instead, which against a black-hole SMTP server would
// hold the request open for the full deadline.
const REQUEST_DEADLINE_MS = 5_000;

export type InviteMailInput = {
	email: string | null;
	token: string;
	workspaceId: string;
	inviterId: string;
};

type MailDb = Pick<typeof defaultDb, "select">;

export type InviteMailDeps = {
	database: MailDb;
	env?: Record<string, string | undefined>;
	// Not `??`: an explicit null is a caller stating "no mailer", and falling
	// through to the env-resolved one would send real mail from a test.
	mailer?: Mailer | null;
	signal?: AbortSignal;
	deadlineMs?: number;
};

function inviteAcceptUrl(base: string, token: string): string {
	return `${base.replace(/\/+$/, "")}/accept?token=${encodeURIComponent(token)}`;
}

export async function sendInviteMail(
	input: InviteMailInput,
	deps: InviteMailDeps,
): Promise<InviteMailStatus> {
	if (input.email == null) return { status: "skipped" };
	const to = mailableAddress(input.email);
	if (to === null) return { status: "invalid_address" };

	const env = deps.env ?? process.env;
	const mailer = deps.mailer === undefined ? mailerFromEnv(env) : deps.mailer;
	if (!mailer) return { status: "smtp_disabled" };

	// The one notion of a public origin in the codebase. Without it the only link
	// we could mint points at localhost, so the mail would be worse than none:
	// the invitee gets an unusable URL and the inviter believes it was delivered.
	const base = ackBaseUrl(env);
	if (base === null) return { status: "no_public_url" };

	const [workspaceRow] = await deps.database
		.select({ name: workspace.name })
		.from(workspace)
		.where(eq(workspace.id, input.workspaceId))
		.limit(1);
	const [inviterRow] = await deps.database
		.select({ name: user.name })
		.from(user)
		.where(eq(user.id, input.inviterId))
		.limit(1);

	const workspaceName = headerSafe(workspaceRow?.name ?? "", NAME_MAX);
	const inviterName = headerSafe(inviterRow?.name ?? "", NAME_MAX);
	const link = inviteAcceptUrl(base, input.token);

	// text/plain only, which is all the transport sends -- so there is no HTML to
	// escape. Both interpolated names are user-controlled, hence headerSafe above:
	// the subject becomes a header, and RFC 2047 carries the non-ASCII case.
	const subject = encodeHeaderValue(
		headerSafe(
			m.invite_mail_subject({ inviter: inviterName, workspace: workspaceName }),
			SUBJECT_MAX,
		),
	);
	const result = await mailer.send(
		{
			to,
			subject,
			text: m.invite_mail_body({
				inviter: inviterName,
				workspace: workspaceName,
				link,
			}),
		},
		{
			signal: deps.signal,
			deadlineMs: deps.deadlineMs ?? REQUEST_DEADLINE_MS,
		},
	);
	if (result.ok) return { status: "sent" };
	return {
		status: "failed",
		retryable: result.failure.retryable,
		category: result.failure.category,
	};
}
