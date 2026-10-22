import { Building2, KeyRound } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	DISPLAY_NAME_MAX_LENGTH,
	signupDisplayName,
} from "../../auth/display-name.ts";
import {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
} from "../../auth/password-policy.ts";
import type { SignInProviderOption } from "../../auth/provider-names.ts";
import { m } from "../../paraglide/messages.js";
import type { PublicSsoProvider } from "../../server/public-config.ts";
import { ProviderMark } from "../components/auth/ProviderMark.tsx";
import { BrandLogo } from "../components/BrandLogo.tsx";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage, totpErrorMessage } from "../lib/auth-messages.ts";
import { signInEmail } from "../lib/email-sign-in.ts";
import { fetchPublicConfig } from "../lib/public-config.ts";
import { passkeysAvailable } from "../lib/secure-context.ts";
import { signInProviderOptions } from "../lib/sign-in-providers.ts";
import {
	retirementErrorMessage,
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
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [notice, setNotice] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [callbackError, setCallbackError] = useState(() =>
		new URLSearchParams(window.location.search).get("error"),
	);
	const [providers, setProviders] = useState<SignInProviderOption[]>([]);
	const [ssoProviders, setSsoProviders] = useState<PublicSsoProvider[]>([]);
	useEffect(() => {
		let active = true;
		void fetchPublicConfig().then(
			(config) => {
				if (!active) return;
				setProviders(signInProviderOptions(config));
				setSsoProviders(config.ssoProviders ?? []);
			},
			() => {
				// Email and passkeys remain usable when config is unavailable.
			},
		);
		return () => {
			active = false;
		};
	}, []);
	const [needsTwoFactor, setNeedsTwoFactor] = useState(false);
	const [twoFactorCode, setTwoFactorCode] = useState("");
	const [backupCode, setBackupCode] = useState("");
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	function changeMode(next: "signin" | "signup") {
		setMode(next);
		setNotice(false);
		setPassword("");
		setError(null);
		setCallbackError(null);
	}

	async function runAction(
		action: () => Promise<void>,
		fallback: () => string,
	) {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setPending(true);
		setError(null);
		setCallbackError(null);
		try {
			await runAfterZeroRetirement(action);
		} catch (error) {
			setError(
				error instanceof ZeroRetirementError
					? retirementErrorMessage(error)
					: fallback(),
			);
		} finally {
			pendingRef.current = false;
			setPending(false);
		}
	}

	function signUp() {
		void runAction(async () => {
			// Sign-up never establishes a session or confirms account existence.
			let name: string;
			try {
				name = signupDisplayName(displayName, email);
			} catch {
				setError(m.account_name_invalid());
				return;
			}
			const res = await authClient.signUp.email({ email, password, name });
			if (res.error) {
				setError(authErrorMessage(res.error, m.login_error_signup_failed));
				return;
			}
			changeMode("signin");
			setNotice(true);
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
		if (!passkeysAvailable("get")) {
			setError(m.auth_passkey_unavailable());
			return;
		}
		void runAction(async () => {
			const res = await authClient.signIn.passkey();
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_passkey_failed));
		}, m.login_error_passkey_failed);
	}

	function signInWith(provider: string) {
		void runAction(async () => {
			const errorURL = new URL(window.location.href);
			errorURL.searchParams.delete("error");
			errorURL.searchParams.delete("error_description");
			errorURL.hash = "";
			const res = await authClient.signIn.social({
				provider,
				errorCallbackURL: errorURL.href,
				...(callbackURL ? { callbackURL } : {}),
			});
			if (res.error)
				setError(authErrorMessage(res.error, m.login_error_sign_in_failed));
		}, m.login_error_sign_in_failed);
	}

	function signInSso(provider: PublicSsoProvider) {
		void runAction(async () => {
			// The server accepts only a few app routes as return addresses, so a deep
			// link falls back to the root rather than failing the sign-in.
			const returnTo = callbackURL ?? "/";
			const res = await authClient.signIn.sso({
				providerId: provider.id,
				callbackURL: returnTo,
				errorCallbackURL: returnTo,
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
			if (res.error) setError(totpErrorMessage(res.error));
		}, m.login_error_totp_network);
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

	const visibleError =
		error ??
		(callbackError
			? authErrorMessage({ code: callbackError }, m.login_error_sign_in_failed)
			: null);
	const errorMessage = visibleError ? (
		<p
			role="alert"
			className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
		>
			{visibleError}
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
				{mode === "signup" && (
					<div className="space-y-2">
						<label htmlFor="login-name" className="text-sm font-medium">
							{m.account_display_name()}
						</label>
						<Input
							id="login-name"
							data-testid="signup-name"
							autoComplete="name"
							maxLength={DISPLAY_NAME_MAX_LENGTH}
							value={displayName}
							onChange={(event) => setDisplayName(event.target.value)}
							disabled={pending}
						/>
						<p className="text-xs text-muted-foreground">
							{m.account_name_signup_hint()}
						</p>
					</div>
				)}
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
				{notice && (
					<p
						data-testid="signup-notice"
						role="status"
						className="text-sm text-muted-foreground"
					>
						{m.login_signup_continue()}
					</p>
				)}
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
				<a
					data-testid="login-forgot-password"
					href="/reset-password"
					className="mt-3 inline-flex min-h-11 items-center rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{m.login_forgot_password()}
				</a>
			)}
			{mode === "signin" && (
				<details className="text-sm text-muted-foreground">
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
				{providers.map((provider) => (
					<Button
						key={provider.id}
						data-testid={`signin-${provider.id}`}
						type="button"
						variant="outline"
						className="h-11 w-full"
						onClick={() => signInWith(provider.id)}
						disabled={pending}
					>
						<ProviderMark provider={provider} />
						{provider.id === "google"
							? m.login_continue_google()
							: m.login_continue_with({ provider: provider.name })}
					</Button>
				))}
				{ssoProviders.map((provider) => (
					<Button
						key={provider.id}
						data-testid="signin-sso"
						type="button"
						variant="outline"
						className="h-11 w-full"
						onClick={() => signInSso(provider)}
						disabled={pending}
					>
						<Building2 aria-hidden="true" />
						{m.login_continue_sso({ name: provider.name })}
					</Button>
				))}
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
