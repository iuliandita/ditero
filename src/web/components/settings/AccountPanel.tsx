import { LogOut } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";

export function AccountPanel() {
	const { signOut } = useKeyring();
	const { data: session } = authClient.useSession();
	const [signingOut, setSigningOut] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function endSession() {
		setSigningOut(true);
		setError(null);
		try {
			await signOut();
		} catch {
			setError(m.security_error_sign_out());
		} finally {
			setSigningOut(false);
		}
	}

	return (
		<div>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0">
					{session?.user.name && (
						<p className="truncate text-sm font-medium">{session.user.name}</p>
					)}
					{session?.user.email && (
						<p
							className="truncate text-sm text-muted-foreground"
							data-testid="settings-account-email"
						>
							{session.user.email}
						</p>
					)}
				</div>
				<Button
					data-testid="sign-out"
					variant="outline"
					className="pointer-coarse:h-11"
					disabled={signingOut}
					onClick={() => void endSession()}
				>
					<LogOut aria-hidden="true" className="rtl:-scale-x-100" />
					{m.security_sign_out()}
				</Button>
			</div>
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
