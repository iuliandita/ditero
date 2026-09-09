import { Copy } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { sealInviteFragment } from "../../../domain/e2e/invite-fragment.ts";
import type { InviteMailStatus } from "../../../domain/invite.ts";
import type { Role } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import { copyText } from "../../lib/clipboard.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { mutationErrorMessage } from "../../lib/mutator-messages.ts";
import { InviteMailNotice } from "./InviteMailNotice";
import { ROLE_LABELS } from "./role-labels.ts";

// Roles a caller may grant, mirroring the server escalation gate in
// auth/invite-create.ts (default policy): only an owner grants owner, admin+
// grants admin, member+ grants member/viewer. The endpoint stays authoritative;
// a stricter DITERO_MEMBER_INVITES=admin instance surfaces as a 4xx below.
export function grantableRoles(caller: Role): Role[] {
	switch (caller) {
		case "owner":
			return ["owner", "admin", "member", "viewer"];
		case "admin":
			return ["admin", "member", "viewer"];
		case "member":
			return ["member", "viewer"];
		default:
			return [];
	}
}

export function InviteDialog({
	workspaceId,
	callerRole,
	open,
	onOpenChange,
	onCreated,
}: {
	workspaceId: string;
	callerRole: Role;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated: (invite: { id: string; link: string }) => void;
}) {
	const { workspaceKey } = useKeyring();
	const options = grantableRoles(callerRole);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>(
		options.includes("member") ? "member" : (options[0] ?? "viewer"),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [mail, setMail] = useState<InviteMailStatus | undefined>(undefined);
	const [sentTo, setSentTo] = useState("");
	const [copied, setCopied] = useState(false);
	const emailId = useId();

	function reset() {
		setEmail("");
		setError(null);
		setLink(null);
		setMail(undefined);
		setSentTo("");
		setCopied(false);
	}

	async function submit() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const intendedEmail = email.trim();
			// A locked or unprovisioned inviter still creates the ordinary async
			// invite. The fragment is an optimization over that path, never a gate.
			const key = intendedEmail ? await workspaceKey(workspaceId) : null;
			const res = await fetch("/api/invite/create", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceId,
					role,
					...(intendedEmail ? { email: intendedEmail } : {}),
					...(key ? { e2eFast: true } : {}),
				}),
			});
			if (!res.ok) {
				const msg = (await res.text()).trim();
				setError(msg || m.invite_create_failed_status({ status: res.status }));
				return;
			}
			const data = (await res.json()) as {
				id: string;
				token: string;
				link: string;
				expiresAt: string | null;
				mail?: InviteMailStatus;
			};
			let createdLink = data.link;
			if (key && data.expiresAt) {
				try {
					const sealed = await sealInviteFragment(key.wdk, {
						inviteId: data.id,
						workspaceId,
						keyVersion: key.keyVersion,
						intendedEmail,
						expiresAt: data.expiresAt,
					});
					const url = new URL(data.link, window.location.origin);
					url.searchParams.set("e2e", sealed.payload);
					url.hash = new URLSearchParams({ e2e: sealed.fragment }).toString();
					createdLink = url.toString();
				} catch (error) {
					// The row and its emailed async link already exist. Preserve that
					// correct fallback rather than turning a convenience failure into a
					// phantom "invite failed" message.
					console.error("e2e: invite fragment unavailable", error);
				}
			}
			setSentTo(intendedEmail);
			setMail(data.mail);
			setLink(createdLink);
			onCreated({ id: data.id, link: createdLink });
		} catch (e) {
			setError(mutationErrorMessage(e, m.invite_create_failed));
		} finally {
			setBusy(false);
		}
	}

	async function copyLink() {
		if (!link) return;
		if (await copyText(link)) setCopied(true);
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) reset();
				onOpenChange(o);
			}}
		>
			<DialogContent data-testid="invite-dialog">
				<DialogHeader>
					<DialogTitle>{m.invite_dialog_title()}</DialogTitle>
					<DialogDescription>{m.invite_dialog_description()}</DialogDescription>
				</DialogHeader>

				{link ? (
					<div className="flex flex-col gap-2">
						<InviteMailNotice mail={mail} email={sentTo} />
						<span className="text-sm text-muted-foreground">
							{m.invite_link_once_hint()}
						</span>
						<div className="flex items-center gap-2">
							<Input
								data-testid="invite-link"
								readOnly
								value={link}
								aria-label={m.invite_link_aria()}
								onFocus={(e) => e.currentTarget.select()}
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label={m.invite_copy_link_aria()}
								data-testid="invite-copy"
								onClick={() => void copyLink()}
							>
								<Copy />
							</Button>
						</div>
						{copied && (
							<span role="status" className="text-sm text-muted-foreground">
								{m.copied_to_clipboard()}
							</span>
						)}
						<Button
							type="button"
							variant="outline"
							className="self-end"
							onClick={reset}
						>
							{m.invite_create_another()}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={emailId} className="text-sm font-medium">
								{m.invite_email_optional_label()}
							</label>
							<Input
								id={emailId}
								data-testid="invite-email"
								type="email"
								placeholder={m.email_placeholder()}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium">{m.field_role()}</span>
							<Select value={role} onValueChange={(v) => setRole(v as Role)}>
								<SelectTrigger
									aria-label={m.field_role()}
									data-testid="invite-role"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{options.map((r) => (
										<SelectItem key={r} value={r}>
											{ROLE_LABELS[r]()}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{error && (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						)}

						<Button
							type="button"
							data-testid="invite-submit"
							disabled={busy}
							className="self-end"
							onClick={() => void submit()}
						>
							{email.trim() ? m.invite_submit_send() : m.invite_submit_link()}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
