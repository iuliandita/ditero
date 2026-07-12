import { useCallback, useEffect, useState } from "react";
import { authClient } from "../lib/auth-client.ts";

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
			setError(result.error.message ?? "Could not load passkeys");
			return;
		}
		setPasskeys(result.data ?? []);
	}, []);

	useEffect(() => {
		void loadPasskeys();
	}, [loadPasskeys]);

	async function addPasskey() {
		setError(null);
		const result = await authClient.passkey.addPasskey({ name: "This device" });
		if (result.error) {
			setError(result.error.message ?? "Could not add passkey");
			return;
		}
		await loadPasskeys();
	}

	async function removePasskey(id: string) {
		setError(null);
		const result = await authClient.passkey.deletePasskey({ id });
		if (result.error) {
			setError(result.error.message ?? "Could not remove passkey");
			return;
		}
		await loadPasskeys();
	}

	async function enableTwoFactor() {
		setError(null);
		const result = await authClient.twoFactor.enable({ password });
		if (result.error) {
			setError(
				result.error.message ?? "Could not enable two-factor authentication",
			);
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
			setError(result.error.message ?? "Invalid authenticator code");
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
			setError(
				result.error.message ?? "Could not disable two-factor authentication",
			);
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
					Security
				</h2>
				<button
					data-testid="sign-out"
					type="button"
					className="border px-2 py-1"
					onClick={() => authClient.signOut()}
				>
					Sign out
				</button>
			</div>

			<div className="mt-4">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-sm font-medium">Passkeys</h3>
					<button
						data-testid="add-passkey"
						type="button"
						className="border px-2 py-1"
						onClick={addPasskey}
					>
						Add passkey
					</button>
				</div>
				<ul className="mt-2 space-y-1">
					{passkeys.map((item) => (
						<li
							key={item.id}
							data-testid="passkey-item"
							className="flex items-center justify-between gap-3 border p-2 text-sm"
						>
							<span>{item.name || "Passkey"}</span>
							<button
								type="button"
								className="border px-2 py-1"
								onClick={() => removePasskey(item.id)}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			</div>

			<div className="mt-4 space-y-2">
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-sm font-medium">Authenticator app</h3>
					<span data-testid="two-factor-status" className="text-sm">
						{twoFactorEnabled ? "Enabled" : "Disabled"}
					</span>
				</div>
				<input
					data-testid="security-password"
					type="password"
					className="w-full border p-2"
					placeholder="Current password"
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
						Disable 2FA
					</button>
				) : (
					<button
						data-testid="enable-2fa"
						type="button"
						className="border px-2 py-1"
						onClick={enableTwoFactor}
					>
						Enable 2FA
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
							placeholder="Authenticator code"
							value={totpCode}
							onChange={(event) => setTotpCode(event.target.value)}
						/>
						<button
							data-testid="verify-2fa"
							type="button"
							className="border px-2 py-1"
							onClick={verifyTwoFactor}
						>
							Verify
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

			{error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
		</section>
	);
}
