import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "../../paraglide/messages.js";
import { EncryptedFilesPanel } from "../components/e2e/EncryptedFilesPanel.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";

type PasskeyRecord = { id: string; name?: string | null };

export function SecurityPanel() {
	const passwordId = useId();
	const { data: session } = authClient.useSession();
	const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
	// False until the first list answers, so "none yet" is never claimed early.
	const [passkeysLoaded, setPasskeysLoaded] = useState(false);
	const [password, setPassword] = useState("");
	const [totpURI, setTotpURI] = useState<string | null>(null);
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [totpCode, setTotpCode] = useState("");
	const [twoFactorEnabled, setTwoFactorEnabled] = useState(
		Boolean(session?.user.twoFactorEnabled),
	);
	const [error, setError] = useState<string | null>(null);
	const [passkeysLoadError, setPasskeysLoadError] = useState<string | null>(
		null,
	);

	const loadPasskeys = useCallback(async () => {
		try {
			const result = await authClient.passkey.listUserPasskeys();
			if (result.error) {
				setPasskeysLoadError(
					authErrorMessage(result.error, m.security_error_load_passkeys),
				);
				return;
			}
			setPasskeys(result.data ?? []);
			setPasskeysLoaded(true);
			setPasskeysLoadError(null);
		} catch {
			setPasskeysLoadError(m.security_error_load_passkeys());
		}
	}, []);

	useEffect(() => {
		void loadPasskeys();
	}, [loadPasskeys]);

	async function addPasskey() {
		setError(null);
		// Persisted, not display text: a localized name would be stored once and
		// then render in that locale for every later session. Do not key it.
		const result = await authClient.passkey.addPasskey({ name: "This device" });
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_add_passkey));
			return;
		}
		// verify-registration returns the row it created, so render that rather than
		// re-reading the list: a failed refresh must never make a passkey that IS
		// registered look like a failed enrollment.
		const created = result.data;
		if (!created) {
			await loadPasskeys();
			return;
		}
		setPasskeys((current) => [
			...current.filter((item) => item.id !== created.id),
			{ id: created.id, name: created.name },
		]);
	}

	async function removePasskey(id: string) {
		setError(null);
		const result = await authClient.passkey.deletePasskey({ id });
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_remove_passkey));
			return;
		}
		await loadPasskeys();
	}

	async function enableTwoFactor() {
		setError(null);
		const result = await authClient.twoFactor.enable({ password });
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_enable_2fa));
			return;
		}
		setPassword("");
		setTotpURI(result.data.totpURI);
		setBackupCodes(result.data.backupCodes);
	}

	async function verifyTwoFactor() {
		setError(null);
		const result = await authClient.twoFactor.verifyTotp({ code: totpCode });
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_invalid_code));
			return;
		}
		setTwoFactorEnabled(true);
		setTotpURI(null);
		setTotpCode("");
	}

	async function disableTwoFactor() {
		setError(null);
		const result = await authClient.twoFactor.disable({ password });
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_disable_2fa));
			return;
		}
		setPassword("");
		setTwoFactorEnabled(false);
		setBackupCodes([]);
	}

	return (
		<div className="flex flex-col gap-8">
			<div>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0">
						<h3 className="text-sm font-semibold">
							{m.security_passkeys_heading()}
						</h3>
						{passkeysLoaded && passkeys.length === 0 && (
							<p
								data-testid="passkeys-empty"
								className="mt-0.5 text-sm text-muted-foreground"
							>
								{m.security_passkeys_empty()}
							</p>
						)}
					</div>
					<Button
						data-testid="add-passkey"
						variant="outline"
						className="pointer-coarse:h-11"
						onClick={() => void addPasskey()}
					>
						<KeyRound aria-hidden="true" />
						{m.security_add_passkey()}
					</Button>
				</div>
				{passkeys.length > 0 && (
					<ul className="mt-3 flex flex-col divide-y rounded-xl border">
						{passkeys.map((item) => (
							<li
								key={item.id}
								data-testid="passkey-item"
								className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
							>
								<span className="min-w-0 truncate">
									{item.name || m.security_passkey_unnamed()}
								</span>
								<Button
									variant="ghost"
									size="sm"
									className="pointer-coarse:h-11"
									onClick={() => void removePasskey(item.id)}
								>
									{m.security_passkey_remove()}
								</Button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h3 className="text-sm font-semibold">{m.security_totp_heading()}</h3>
					<span
						data-testid="two-factor-status"
						className="text-sm text-muted-foreground"
					>
						{twoFactorEnabled
							? m.security_totp_enabled()
							: m.security_totp_disabled()}
					</span>
				</div>
				<div className="flex flex-col gap-1 text-sm">
					<label htmlFor={passwordId} className="text-muted-foreground">
						{m.security_password_placeholder()}
					</label>
					<span className="flex flex-wrap items-center gap-2">
						<Input
							id={passwordId}
							data-testid="security-password"
							type="password"
							autoComplete="current-password"
							className="w-full sm:w-64 pointer-coarse:h-11"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						{twoFactorEnabled ? (
							<Button
								data-testid="disable-2fa"
								variant="outline"
								className="pointer-coarse:h-11"
								onClick={() => void disableTwoFactor()}
							>
								{m.security_disable_2fa()}
							</Button>
						) : (
							<Button
								data-testid="enable-2fa"
								variant="outline"
								className="pointer-coarse:h-11"
								onClick={() => void enableTwoFactor()}
							>
								{m.security_enable_2fa()}
							</Button>
						)}
					</span>
				</div>

				{totpURI ? (
					<div className="flex flex-col gap-2">
						<code
							data-testid="totp-uri"
							className="block rounded-lg bg-muted px-3 py-2 text-xs break-all"
						>
							{totpURI}
						</code>
						<span className="flex flex-wrap items-center gap-2">
							<Input
								data-testid="totp-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								aria-label={m.security_totp_code_placeholder()}
								className="w-full sm:w-40 pointer-coarse:h-11"
								placeholder={m.security_totp_code_placeholder()}
								value={totpCode}
								onChange={(event) => setTotpCode(event.target.value)}
							/>
							<Button
								data-testid="verify-2fa"
								className="pointer-coarse:h-11"
								onClick={() => void verifyTwoFactor()}
							>
								{m.security_verify_2fa()}
							</Button>
						</span>
					</div>
				) : null}

				{backupCodes.length ? (
					<ul className="grid w-fit grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-muted px-3 py-2 font-mono text-xs tabular-nums">
						{backupCodes.map((code) => (
							<li key={code} data-testid="backup-code">
								{code}
							</li>
						))}
					</ul>
				) : null}
			</div>

			{session?.user.id && <EncryptedFilesPanel userId={session.user.id} />}

			{error || passkeysLoadError ? (
				<p role="alert" className="text-sm text-destructive">
					{error ?? passkeysLoadError}
				</p>
			) : null}
		</div>
	);
}
