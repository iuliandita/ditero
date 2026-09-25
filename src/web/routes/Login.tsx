import { ListChecks } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";
import { signInEmail } from "../lib/email-sign-in.ts";

function AuthShell({ children }: { children: ReactNode }) {
	return (
		<main className="flex min-h-dvh items-center justify-center bg-muted/30 px-4 py-4 text-foreground">
			<div className="w-full max-w-[27.5rem]">
				<div className="mb-4 flex items-center justify-center gap-2.5">
					<div className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
						<ListChecks
							aria-hidden="true"
							className="size-4"
							strokeWidth={2.2}
						/>
					</div>
					<span className="text-sm font-semibold tracking-wide">Ditero</span>
				</div>
				<section className="rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-sm">
					{children}
				</section>
				<div className="mx-auto mt-4 w-full max-w-56">
					<LanguageSwitcher />
				</div>
			</div>
		</main>
	);
}

export function Login() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
	const [twoFactorCode, setTwoFactorCode] = useState("");
	const [backupCode, setBackupCode] = useState("");
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);

	async function runAction(
		action: () => Promise<void>,
		fallback: () => string,
	) {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			await action();
		} catch {
			setError(fallback());
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}

	function signUp() {
		void runAction(async () => {
			// Email verification is off, so signup yields an active session directly.
			const name = email.split("@")[0] || email;
			const res = await authClient.signUp.email({ email, password, name });
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_signup_failed));
		}, m.login_error_signup_failed);
	}

	function signIn() {
		void runAction(async () => {
			const result = await signInEmail(email, password);
			if (result.kind === "error") setError(result.message);
			if (result.kind === "two-factor") setNeedsTwoFactor(true);
			if (result.kind === "signed-in") window.location.reload();
		}, m.login_error_sign_in_failed);
	}

	function signInPasskey() {
		void runAction(async () => {
			const res = await authClient.signIn.passkey();
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_passkey_failed));
		}, m.login_error_passkey_failed);
	}

	function signInGoogle() {
		void runAction(async () => {
			const res = await authClient.signIn.social({ provider: "google" });
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_sign_in_failed));
		}, m.login_error_sign_in_failed);
	}

	function verifyTOTP() {
		void runAction(async () => {
			const res = await authClient.twoFactor.verifyTotp({
				code: twoFactorCode,
			});
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_invalid_totp));
		}, m.login_error_invalid_totp);
	}

	function verifyBackupCode() {
		void runAction(async () => {
			const res = await authClient.twoFactor.verifyBackupCode({
				code: backupCode,
			});
			if (res.error)
				setError(
					authErrorMessage(res.error, m.login_error_invalid_backup_code),
				);
		}, m.login_error_invalid_backup_code);
	}

	const errorMessage = error ? (
		<p
			role="alert"
			className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
		>
			{error}
		</p>
	) : null;

	if (needsTwoFactor) {
		return (
			<AuthShell>
				<div data-testid="two-factor-challenge">
					<h1 className="text-2xl font-semibold tracking-tight">
						{m.login_two_factor_title()}
					</h1>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						{m.login_two_factor_description()}
					</p>
					<form
						className="mt-6 space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							verifyTOTP();
						}}
					>
						<div className="space-y-2">
							<label
								htmlFor="login-two-factor-code"
								className="text-sm font-medium"
							>
								{m.login_totp_label()}
							</label>
							<Input
								id="login-two-factor-code"
								data-testid="two-factor-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								className="h-11"
								placeholder={m.security_totp_code_placeholder()}
								value={twoFactorCode}
								onChange={(event) => setTwoFactorCode(event.target.value)}
								disabled={pending}
								required
							/>
						</div>
						<Button
							data-testid="verify-totp"
							type="submit"
							className="h-11 w-full"
							disabled={pending}
						>
							{m.login_verify_code()}
						</Button>
					</form>
					<div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
						<span className="h-px flex-1 bg-border" />
						<span>{m.login_backup_option()}</span>
						<span className="h-px flex-1 bg-border" />
					</div>
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							verifyBackupCode();
						}}
					>
						<div className="space-y-2">
							<label
								htmlFor="login-backup-code"
								className="text-sm font-medium"
							>
								{m.login_backup_code_label()}
							</label>
							<Input
								id="login-backup-code"
								data-testid="backup-code-input"
								className="h-11"
								placeholder={m.login_backup_code_placeholder()}
								value={backupCode}
								onChange={(event) => setBackupCode(event.target.value)}
								disabled={pending}
								required
							/>
						</div>
						<Button
							data-testid="verify-backup-code"
							type="submit"
							variant="outline"
							className="h-11 w-full"
							disabled={pending}
						>
							{m.login_use_backup_code()}
						</Button>
					</form>
					{error ? <div className="mt-4">{errorMessage}</div> : null}
				</div>
			</AuthShell>
		);
	}

	return (
		<AuthShell>
			<h1 className="text-2xl font-semibold tracking-tight">
				{m.login_heading()}
			</h1>
			<p className="mt-2 text-sm leading-6 text-muted-foreground">
				{m.login_description()}
			</p>
			<form
				className="mt-6 space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					signIn();
				}}
			>
				<div className="space-y-2">
					<label htmlFor="login-email" className="text-sm font-medium">
						{m.login_email_label()}
					</label>
					<Input
						id="login-email"
						data-testid="email"
						type="email"
						autoComplete="email"
						className="h-11"
						placeholder={m.login_email_placeholder()}
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						disabled={pending}
						required
					/>
				</div>
				<div className="space-y-2">
					<label htmlFor="login-password" className="text-sm font-medium">
						{m.login_password_label()}
					</label>
					<Input
						id="login-password"
						data-testid="password"
						type="password"
						autoComplete="current-password"
						className="h-11"
						placeholder={m.login_password_placeholder()}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						disabled={pending}
						required
					/>
				</div>
				{errorMessage}
				<div className="space-y-2 pt-2">
					<Button
						data-testid="signin"
						type="submit"
						className="h-11 w-full"
						disabled={pending}
					>
						{m.login_signin()}
					</Button>
					<Button
						data-testid="signup"
						type="button"
						variant="outline"
						className="h-11 w-full"
						onClick={(event) => {
							if (event.currentTarget.form?.reportValidity()) signUp();
						}}
						disabled={pending}
					>
						{m.login_signup()}
					</Button>
				</div>
			</form>
			<div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
				<span className="h-px flex-1 bg-border" />
				<span>{m.login_other_options()}</span>
				<span className="h-px flex-1 bg-border" />
			</div>
			<div className="grid gap-2">
				<Button
					data-testid="signin-passkey"
					type="button"
					variant="outline"
					className="h-11 w-full"
					onClick={signInPasskey}
					disabled={pending}
				>
					{m.login_signin_passkey()}
				</Button>
				<Button
					type="button"
					variant="outline"
					className="h-11 w-full"
					onClick={signInGoogle}
					disabled={pending}
				>
					{m.login_continue_google()}
				</Button>
			</div>
		</AuthShell>
	);
}
