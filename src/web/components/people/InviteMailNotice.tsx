import { inviteMailMessage } from "@/lib/channel-messages";
import type { InviteMailStatus } from "../../../domain/invite.ts";

// An invite whose mail never went out still has a usable link, so this sits next
// to the link rather than replacing it: the inviter's mental model is "I invited
// them", and a silent send failure leaves that wrong.
export function InviteMailNotice({
	mail,
	email,
}: {
	mail: InviteMailStatus | undefined;
	email: string;
}) {
	const message = mail ? inviteMailMessage(mail, email) : null;
	if (!message) return null;
	return (
		<p
			data-testid="invite-mail-status"
			data-tone={message.tone}
			role={message.tone === "warning" ? "alert" : "status"}
			className={
				message.tone === "warning"
					? "text-sm text-destructive"
					: "text-sm text-muted-foreground"
			}
		>
			{message.text}
		</p>
	);
}
