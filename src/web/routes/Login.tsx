import { useState } from "react";
import { authClient } from "../lib/auth-client.ts";
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
		if (res.error) setError(res.error.message ?? "sign up failed");
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
		if (res.error) setError(res.error.message ?? "passkey sign in failed");
	}

	async function verifyTOTP() {
		setError(null);
		const res = await authClient.twoFactor.verifyTotp({ code: twoFactorCode });
		if (res.error) setError(res.error.message ?? "invalid authenticator code");
	}

	async function verifyBackupCode() {
		setError(null);
		const res = await authClient.twoFactor.verifyBackupCode({
			code: backupCode,
		});
		if (res.error) setError(res.error.message ?? "invalid backup code");
	}

	if (needsTwoFactor) {
		return (
			<div
				data-testid="two-factor-challenge"
				className="mx-auto flex max-w-sm flex-col gap-2 p-6"
			>
				<h1 className="text-lg font-semibold">Two-factor authentication</h1>
				<input
					data-testid="two-factor-code"
					inputMode="numeric"
					className="border p-2"
					placeholder="Authenticator code"
					value={twoFactorCode}
					onChange={(event) => setTwoFactorCode(event.target.value)}
				/>
				<button
					data-testid="verify-totp"
					type="button"
					className="border bg-black p-2 text-white"
					onClick={verifyTOTP}
				>
					Verify code
				</button>
				<input
					data-testid="backup-code-input"
					className="border p-2"
					placeholder="Backup code"
					value={backupCode}
					onChange={(event) => setBackupCode(event.target.value)}
				/>
				<button
					data-testid="verify-backup-code"
					type="button"
					className="border p-2"
					onClick={verifyBackupCode}
				>
					Use backup code
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
				placeholder="email"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
			/>
			<input
				data-testid="password"
				className="border p-2"
				type="password"
				placeholder="password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
			/>
			<button
				data-testid="signup"
				className="border bg-black p-2 text-white"
				type="button"
				onClick={signUp}
			>
				Sign up
			</button>
			<button
				data-testid="signin"
				className="border p-2"
				type="button"
				onClick={signIn}
			>
				Sign in
			</button>
			<button
				data-testid="signin-passkey"
				className="border p-2"
				type="button"
				onClick={signInPasskey}
			>
				Sign in with passkey
			</button>
			<button
				className="border p-2"
				type="button"
				onClick={() => authClient.signIn.social({ provider: "google" })}
			>
				Continue with Google
			</button>
			{error ? <p className="text-red-600">{error}</p> : null}
		</div>
	);
}
