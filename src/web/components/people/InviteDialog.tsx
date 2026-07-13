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

export type Role = "owner" | "admin" | "member" | "viewer";

const ROLE_LABELS: Record<Role, string> = {
	owner: "Owner",
	admin: "Admin",
	member: "Member",
	viewer: "Viewer",
};

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
	const options = grantableRoles(callerRole);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>(
		options.includes("member") ? "member" : (options[0] ?? "viewer"),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const emailId = useId();

	function reset() {
		setEmail("");
		setError(null);
		setLink(null);
		setCopied(false);
	}

	async function submit() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/invite/create", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceId,
					role,
					...(email.trim() ? { email: email.trim() } : {}),
				}),
			});
			if (!res.ok) {
				const msg = (await res.text()).trim();
				setError(msg || `Could not create the invite (${res.status}).`);
				return;
			}
			const data = (await res.json()) as {
				id: string;
				token: string;
				link: string;
			};
			setLink(data.link);
			onCreated({ id: data.id, link: data.link });
		} catch (e) {
			console.error(e);
			setError(e instanceof Error ? e.message : "Could not create the invite.");
		} finally {
			setBusy(false);
		}
	}

	async function copyLink() {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			setCopied(true);
		} catch (e) {
			console.error(e);
		}
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
					<DialogTitle>Invite people</DialogTitle>
					<DialogDescription>
						Add an email to send a targeted invite, or leave it blank to create
						a shareable link.
					</DialogDescription>
				</DialogHeader>

				{link ? (
					<div className="flex flex-col gap-2">
						<span className="text-sm text-muted-foreground">
							Invite link (copy it now, it is shown only once):
						</span>
						<div className="flex items-center gap-2">
							<Input
								data-testid="invite-link"
								readOnly
								value={link}
								aria-label="Invite link"
								onFocus={(e) => e.currentTarget.select()}
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="Copy invite link"
								data-testid="invite-copy"
								onClick={() => void copyLink()}
							>
								<Copy />
							</Button>
						</div>
						{copied && (
							<span role="status" className="text-sm text-muted-foreground">
								Copied to clipboard.
							</span>
						)}
						<Button
							type="button"
							variant="outline"
							className="self-end"
							onClick={reset}
						>
							Create another
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={emailId} className="text-sm font-medium">
								Email (optional)
							</label>
							<Input
								id={emailId}
								data-testid="invite-email"
								type="email"
								placeholder="name@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium">Role</span>
							<Select value={role} onValueChange={(v) => setRole(v as Role)}>
								<SelectTrigger
									aria-label="Role"
									data-testid="invite-role"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{options.map((r) => (
										<SelectItem key={r} value={r}>
											{ROLE_LABELS[r]}
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
							{email.trim() ? "Send invite" : "Create link"}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
