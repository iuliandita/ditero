import { useState } from "react";
import { m } from "../../paraglide/messages.js";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";
import { signInEmail } from "../lib/email-sign-in.ts";

export function Login() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
	const [twoFactorCode, setTwoFactorCode] = useState("");
	const [backupCode, setBackupCode] = useState("");

	async function signUp() {
		setError(null);
		// Email verification is off, so signup yields an active session directly.
		const name = email.split("@")[0] || email;
		const res = await authClient.signUp.email({ email, password, name });
		if (res.error)
			setError(authErrorMessage(res.error, m.login_error_signup_failed));
	}

	async function signIn() {
		setError(null);
		const result = await signInEmail(email, password);
		if (result.kind === "error") setError(result.message);
		if (result.kind === "two-factor") setNeedsTwoFactor(true);
		if (result.kind === "signed-in") window.location.reload();
	}

	async function signInPasskey() {
		setError(null);
		const res = await authClient.signIn.passkey();
		if (res.error)
			setError(authErrorMessage(res.error, m.login_error_passkey_failed));
	}

	async function verifyTOTP() {
		setError(null);
		const res = await authClient.twoFactor.verifyTotp({ code: twoFactorCode });
		if (res.error)
			setError(authErrorMessage(res.error, m.login_error_invalid_totp));
	}

	async function verifyBackupCode() {
		setError(null);
		const res = await authClient.twoFactor.verifyBackupCode({
			code: backupCode,
		});
		if (res.error)
			setError(authErrorMessage(res.error, m.login_error_invalid_backup_code));
	}

	if (needsTwoFactor) {
		return (
			<div
				data-testid="two-factor-challenge"
				className="mx-auto flex max-w-sm flex-col gap-2 p-6"
			>
				<h1 className="text-lg font-semibold">{m.login_two_factor_title()}</h1>
				<input
					data-testid="two-factor-code"
					inputMode="numeric"
					className="border p-2"
					placeholder={m.security_totp_code_placeholder()}
					value={twoFactorCode}
					onChange={(event) => setTwoFactorCode(event.target.value)}
				/>
				<button
					data-testid="verify-totp"
					type="button"
					className="border bg-black p-2 text-white"
					onClick={verifyTOTP}
				>
					{m.login_verify_code()}
				</button>
				<input
					data-testid="backup-code-input"
					className="border p-2"
					placeholder={m.login_backup_code_placeholder()}
					value={backupCode}
					onChange={(event) => setBackupCode(event.target.value)}
				/>
				<button
					data-testid="verify-backup-code"
					type="button"
					className="border p-2"
					onClick={verifyBackupCode}
				>
					{m.login_use_backup_code()}
				</button>
				{error ? <p className="text-red-600">{error}</p> : null}
			</div>
		);
	}

	return (
		<div className="mx-auto flex max-w-sm flex-col gap-2 p-6">
			<h1 className="text-lg font-semibold">Ditero</h1>
			<input
				data-testid="email"
				className="border p-2"
				placeholder={m.login_email_placeholder()}
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<input
				data-testid="password"
				className="border p-2"
				type="password"
				placeholder={m.login_password_placeholder()}
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
			<button
				data-testid="signup"
				className="border bg-black p-2 text-white"
				type="button"
				onClick={signUp}
			>
				{m.login_signup()}
			</button>
			<button
				data-testid="signin"
				className="border p-2"
				type="button"
				onClick={signIn}
			>
				{m.login_signin()}
			</button>
			<button
				data-testid="signin-passkey"
				className="border p-2"
				type="button"
				onClick={signInPasskey}
			>
				{m.login_signin_passkey()}
			</button>
			<button
				className="border p-2"
				type="button"
				onClick={() => authClient.signIn.social({ provider: "google" })}
			>
				{m.login_continue_google()}
			</button>
			{error ? <p className="text-red-600">{error}</p> : null}
			<div className="mt-4 border-t pt-4">
				<LanguageSwitcher />
			</div>
		</div>
	);
}
