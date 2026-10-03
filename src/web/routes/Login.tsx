import { KeyRound } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
} from "../../auth/password-policy.ts";
import { m } from "../../paraglide/messages.js";
import { GoogleMark } from "../components/auth/GoogleMark.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";
import { signInEmail } from "../lib/email-sign-in.ts";
import {
	runAfterZeroRetirement,
	ZeroRetirementError,
} from "../lib/zero-lifecycle.ts";

// Top-anchored on purpose: a centered column re-centers (and moves the logo)
// whenever an error grows the content below it. A fixed top offset keeps
// everything above the growing region pinned regardless of what appears below.
export function AuthShell({ children }: { children: ReactNode }) {
	return (
		<main className="flex min-h-dvh justify-center bg-background px-6 pt-16 pb-10 text-foreground sm:pt-24">
			<div className="flex w-full max-w-sm flex-col">
				<BrandLogo className="mb-7" />
				{children}
				<div className="mt-8">
					<LanguageSwitcher compact />
				</div>
			</div>
		</main>
	);
}

// `callbackURL` only carries a same-origin return path through the Google
// redirect; the caller builds it, and the other sign-in flows ignore it.
export function Login({ callbackURL }: { callbackURL?: string } = {}) {
	const [mode, setMode] = useState<"signin" | "signup">("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
	const [twoFactorCode, setTwoFactorCode] = useState("");
	const [backupCode, setBackupCode] = useState("");
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	function changeMode(next: "signin" | "signup") {
		setMode(next);
		setPassword("");
		setError(null);
	}

	async function runAction(
		action: () => Promise<void>,
		fallback: () => string,
	) {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		try {
			await runAfterZeroRetirement(action);
		} catch (error) {
			setError(
				error instanceof ZeroRetirementError
					? m.sync_save_pending_failed()
					: fallback(),
			);
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
			const res = await authClient.signIn.social({
				provider: "google",
				...(callbackURL ? { callbackURL } : {}),
			});
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
						className="mt-7 space-y-4"
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
					<div className="mt-8 border-t border-border/70 pt-5">
						<p className="mb-3 text-sm text-muted-foreground">
							{m.login_backup_option()}
						</p>
						<form
							className="space-y-4"
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
								variant="secondary"
								className="h-11 w-full"
								disabled={pending}
							>
								{m.login_use_backup_code()}
							</Button>
						</form>
					</div>
					{error ? <div className="mt-4">{errorMessage}</div> : null}
				</div>
			</AuthShell>
		);
	}

	return (
		<AuthShell>
			<h1 className="mb-6 text-lg font-semibold">
				{mode === "signup" ? m.login_signup() : m.login_signin()}
			</h1>
			<form
				className="space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (mode === "signup") signUp();
					else signIn();
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
						autoComplete={
							mode === "signup" ? "new-password" : "current-password"
						}
						minLength={mode === "signup" ? PASSWORD_MIN_LENGTH : undefined}
						maxLength={mode === "signup" ? PASSWORD_MAX_LENGTH : undefined}
						aria-describedby={
							mode === "signup" ? "signup-password-guidance" : undefined
						}
						className="h-11"
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						disabled={pending}
						required
					/>
					{mode === "signup" && (
						<p
							id="signup-password-guidance"
							className="text-xs leading-5 text-muted-foreground"
						>
							{m.login_password_guidance({
								min: PASSWORD_MIN_LENGTH,
								max: PASSWORD_MAX_LENGTH,
							})}
						</p>
					)}
				</div>
				{errorMessage}
				<Button
					data-testid={mode === "signup" ? "signup" : "signin"}
					type="submit"
					className="h-11 w-full"
					disabled={pending}
				>
					{mode === "signup" ? m.login_signup() : m.login_signin()}
				</Button>
			</form>
			{mode === "signin" && (
				<details className="mt-3 text-sm text-muted-foreground">
					<summary
						data-testid="login-recovery"
						className="min-h-11 cursor-pointer content-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
					>
						{m.login_recovery_label()}
					</summary>
					<p className="mt-1 leading-6">{m.login_recovery_admin_guidance()}</p>
				</details>
			)}
			<div className="my-5 flex items-center gap-3">
				<div aria-hidden="true" className="h-px flex-1 bg-border" />
				<span className="text-xs font-medium text-muted-foreground">
					{m.login_or()}
				</span>
				<div aria-hidden="true" className="h-px flex-1 bg-border" />
			</div>
			<div className="space-y-2">
				<p className="sr-only">{m.login_other_options()}</p>
				<Button
					data-testid="signin-passkey"
					type="button"
					variant="outline"
					className="h-11 w-full"
					onClick={signInPasskey}
					disabled={pending}
				>
					<KeyRound aria-hidden="true" />
					{m.login_signin_passkey()}
				</Button>
				<Button
					data-testid="signin-google"
					type="button"
					variant="outline"
					className="h-11 w-full"
					onClick={signInGoogle}
					disabled={pending}
				>
					<GoogleMark />
					{m.login_continue_google()}
				</Button>
			</div>
			<p className="mt-6 text-center text-sm text-muted-foreground">
				{mode === "signup" ? m.login_existing_account() : m.login_new_here()}{" "}
				<Button
					data-testid={mode === "signup" ? "signin-mode" : "signup-mode"}
					type="button"
					variant="link"
					className="h-auto min-h-11 px-1 py-0 text-sm"
					onClick={() => changeMode(mode === "signup" ? "signin" : "signup")}
					disabled={pending}
				>
					{mode === "signup" ? m.login_signin() : m.login_signup()}
				</Button>
			</p>
		</AuthShell>
	);
}
