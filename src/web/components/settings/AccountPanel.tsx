import { LogOut } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { useNativeAccount } from "../../lib/native-account.tsx";

export function AccountPanel() {
	const native = useNativeAccount();
	return native ? (
		<AccountContent profile={native.profile} />
	) : (
		<BrowserAccountPanel />
	);
}

function BrowserAccountPanel() {
	const { data: session } = authClient.useSession();
	return <AccountContent profile={session?.user} />;
}

function AccountContent({
	profile,
}: {
	profile?: { name?: string; email?: string };
}) {
	const { signOut } = useKeyring();
	const native = useNativeAccount();
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
					{profile?.name && (
						<p className="truncate text-sm font-medium">{profile.name}</p>
					)}
					{profile?.email && (
						<p
							className="truncate text-sm text-muted-foreground"
							data-testid="settings-account-email"
						>
							{profile.email}
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
			{native && (
				<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
					<p className="min-w-0 break-all text-sm text-muted-foreground">
						{native.origin}
					</p>
					<Button
						variant="outline"
						className="pointer-coarse:h-11"
						disabled={signingOut}
						onClick={() => {
							setSigningOut(true);
							setError(null);
							void native
								.changeServer()
								.catch(() => setError(m.security_error_sign_out()))
								.finally(() => setSigningOut(false));
						}}
					>
						{m.native_change_server()}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
