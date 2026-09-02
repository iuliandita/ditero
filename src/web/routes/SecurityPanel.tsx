import { useCallback, useEffect, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { EncryptedFilesPanel } from "../components/e2e/EncryptedFilesPanel.tsx";
import { AccountDeletionPanel } from "../components/settings/AccountDeletionPanel.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";

type PasskeyRecord = { id: string; name?: string | null };

export function SecurityPanel() {
	const { data: session } = authClient.useSession();
	const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
	const [password, setPassword] = useState("");
	const [totpURI, setTotpURI] = useState<string | null>(null);
	const [backupCodes, setBackupCodes] = useState<string[]>([]);
	const [totpCode, setTotpCode] = useState("");
	const [twoFactorEnabled, setTwoFactorEnabled] = useState(
		Boolean(session?.user.twoFactorEnabled),
	);
	const [error, setError] = useState<string | null>(null);

	const loadPasskeys = useCallback(async () => {
		const result = await authClient.passkey.listUserPasskeys();
		if (result.error) {
			setError(authErrorMessage(result.error, m.security_error_load_passkeys));
			return;
		}
		setPasskeys(result.data ?? []);
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
		<section className="mt-8 border-t pt-4" aria-labelledby="security-heading">
			<div className="flex items-center justify-between gap-4">
				<h2 id="security-heading" className="text-sm font-semibold">
					{m.security_heading()}
				</h2>
				<button
					data-testid="sign-out"
					type="button"
					className="border px-2 py-1"
					onClick={() => authClient.signOut()}
				>
					{m.security_sign_out()}
				</button>
			</div>

			<div className="mt-4">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-sm font-medium">
						{m.security_passkeys_heading()}
					</h3>
					<button
						data-testid="add-passkey"
						type="button"
						className="border px-2 py-1"
						onClick={addPasskey}
					>
						{m.security_add_passkey()}
					</button>
				</div>
				<ul className="mt-2 space-y-1">
					{passkeys.map((item) => (
						<li
							key={item.id}
							data-testid="passkey-item"
							className="flex items-center justify-between gap-3 border p-2 text-sm"
						>
							<span>{item.name || m.security_passkey_unnamed()}</span>
							<button
								type="button"
								className="border px-2 py-1"
								onClick={() => removePasskey(item.id)}
							>
								{m.security_passkey_remove()}
							</button>
						</li>
					))}
				</ul>
			</div>

			<div className="mt-4 space-y-2">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-sm font-medium">{m.security_totp_heading()}</h3>
					<span data-testid="two-factor-status" className="text-sm">
						{twoFactorEnabled
							? m.security_totp_enabled()
							: m.security_totp_disabled()}
					</span>
				</div>
				<input
					data-testid="security-password"
					type="password"
					className="w-full border p-2"
					placeholder={m.security_password_placeholder()}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
				{twoFactorEnabled ? (
					<button
						data-testid="disable-2fa"
						type="button"
						className="border px-2 py-1"
						onClick={disableTwoFactor}
					>
						{m.security_disable_2fa()}
					</button>
				) : (
					<button
						data-testid="enable-2fa"
						type="button"
						className="border px-2 py-1"
						onClick={enableTwoFactor}
					>
						{m.security_enable_2fa()}
					</button>
				)}

				{totpURI ? (
					<div className="space-y-2">
						<code data-testid="totp-uri" className="block break-all text-xs">
							{totpURI}
						</code>
						<input
							data-testid="totp-code"
							inputMode="numeric"
							className="w-full border p-2"
							placeholder={m.security_totp_code_placeholder()}
							value={totpCode}
							onChange={(event) => setTotpCode(event.target.value)}
						/>
						<button
							data-testid="verify-2fa"
							type="button"
							className="border px-2 py-1"
							onClick={verifyTwoFactor}
						>
							{m.security_verify_2fa()}
						</button>
					</div>
				) : null}

				{backupCodes.length ? (
					<ul className="grid grid-cols-2 gap-1 font-mono text-xs">
						{backupCodes.map((code) => (
							<li key={code} data-testid="backup-code">
								{code}
							</li>
						))}
					</ul>
				) : null}
			</div>

			{session?.user.id && <EncryptedFilesPanel userId={session.user.id} />}

			<AccountDeletionPanel />

			{error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
		</section>
	);
}
