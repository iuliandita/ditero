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

// A kid is only ever granted member/viewer in the shared workspace (mirrors the
// server MANAGED_ROLES gate in auth/managed-account.ts).
type ManagedRole = "member" | "viewer";

const ROLE_LABELS: Record<ManagedRole, string> = {
	member: "Member",
	viewer: "Viewer",
};

export function AddKid({
	workspaceId,
	open,
	onOpenChange,
}: {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<ManagedRole>("member");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [handle, setHandle] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const nameId = useId();
	const passwordId = useId();

	function reset() {
		setDisplayName("");
		setPassword("");
		setRole("member");
		setError(null);
		setHandle(null);
		setCopied(false);
	}

	async function submit() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/account/managed", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspaceId,
					displayName: displayName.trim(),
					password,
					role,
				}),
			});
			if (!res.ok) {
				const msg = (await res.text()).trim();
				setError(msg || `Could not add the child account (${res.status}).`);
				return;
			}
			const data = (await res.json()) as { userId: string; email: string };
			setHandle(data.email);
		} catch (e) {
			console.error(e);
			setError(
				e instanceof Error ? e.message : "Could not add the child account.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function copyHandle() {
		if (!handle) return;
		try {
			await navigator.clipboard.writeText(handle);
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
			<DialogContent data-testid="add-kid-dialog">
				<DialogHeader>
					<DialogTitle>Add child account</DialogTitle>
					<DialogDescription>
						Provision a restricted account. The child signs in with the handle
						below and the password you set -- they only see tasks assigned to
						them.
					</DialogDescription>
				</DialogHeader>

				{handle ? (
					<div className="flex flex-col gap-2">
						<span className="text-sm text-muted-foreground">
							Sign-in handle (share it with the password you set):
						</span>
						<div className="flex items-center gap-2">
							<Input
								data-testid="add-kid-handle"
								readOnly
								value={handle}
								aria-label="Sign-in handle"
								onFocus={(e) => e.currentTarget.select()}
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="Copy sign-in handle"
								data-testid="add-kid-copy"
								onClick={() => void copyHandle()}
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
							Add another
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={nameId} className="text-sm font-medium">
								Name
							</label>
							<Input
								id={nameId}
								data-testid="add-kid-name"
								value={displayName}
								placeholder="Child's name"
								onChange={(e) => setDisplayName(e.target.value)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<label htmlFor={passwordId} className="text-sm font-medium">
								Password
							</label>
							<Input
								id={passwordId}
								data-testid="add-kid-password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</div>

						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium">Role</span>
							<Select
								value={role}
								onValueChange={(v) => setRole(v as ManagedRole)}
							>
								<SelectTrigger
									aria-label="Role"
									data-testid="add-kid-role"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="member">{ROLE_LABELS.member}</SelectItem>
									<SelectItem value="viewer">{ROLE_LABELS.viewer}</SelectItem>
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
							data-testid="add-kid-submit"
							disabled={busy || !displayName.trim() || !password}
							className="self-end"
							onClick={() => void submit()}
						>
							Add child
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
