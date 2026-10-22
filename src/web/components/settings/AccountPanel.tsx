import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DISPLAY_NAME_MAX_LENGTH,
	normalizeDisplayName,
} from "../../../auth/display-name.ts";
import { m } from "../../../paraglide/messages.js";
import { authClient } from "../../lib/auth-client.ts";
import { useKeyring } from "../../lib/e2e/KeyringProvider.tsx";
import { useNativeAccount } from "../../lib/native-account.tsx";
import {
	retirementErrorMessage,
	runAfterZeroRetirement,
	ZeroRetirementError,
} from "../../lib/zero-lifecycle.ts";
import { Input } from "../ui/input.tsx";
import { LinkedProvidersPanel } from "./LinkedProvidersPanel.tsx";

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
	return (
		<>
			<AccountContent profile={session?.user} />
			<DisplayNameForm name={session?.user.name ?? ""} />
			<LinkedProvidersPanel />
		</>
	);
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
			await runAfterZeroRetirement(signOut);
		} catch (error) {
			setError(
				error instanceof ZeroRetirementError
					? retirementErrorMessage(error)
					: m.security_error_sign_out(),
			);
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
								.catch((error: unknown) =>
									setError(
										error instanceof ZeroRetirementError
											? retirementErrorMessage(error)
											: m.security_error_sign_out(),
									),
								)
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

function DisplayNameForm({ name }: { name: string }) {
	const [value, setValue] = useState(name);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	useEffect(() => setValue(name), [name]);
	return (
		<form
			className="mt-4 space-y-2"
			onSubmit={async (event) => {
				event.preventDefault();
				if (saving) return;
				let normalized: string;
				try {
					normalized = normalizeDisplayName(value);
				} catch {
					setMessage(m.account_name_invalid());
					return;
				}
				setSaving(true);
				setMessage(null);
				try {
					const result = await authClient.updateUser({ name: normalized });
					if (result.error) {
						setMessage(m.account_name_failed());
						return;
					}
					setValue(normalized);
					setMessage(m.account_name_saved());
				} catch {
					setMessage(m.account_name_failed());
				} finally {
					setSaving(false);
				}
			}}
		>
			<label htmlFor="account-display-name" className="text-sm font-medium">
				{m.account_display_name()}
			</label>
			<div className="flex gap-2">
				<Input
					id="account-display-name"
					data-testid="account-display-name"
					autoComplete="name"
					maxLength={DISPLAY_NAME_MAX_LENGTH}
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						setMessage(null);
					}}
					disabled={saving}
					required
				/>
				<Button
					type="submit"
					data-testid="save-display-name"
					disabled={saving || value === name}
				>
					{m.account_name_save()}
				</Button>
			</div>
			{message && (
				<p role="status" className="text-sm">
					{message}
				</p>
			)}
		</form>
	);
}
