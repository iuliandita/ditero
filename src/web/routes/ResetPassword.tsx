import { type FormEvent, useEffect, useRef, useState } from "react";
import {
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
} from "../../auth/password-policy.ts";
import { m } from "../../paraglide/messages.js";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import {
	newPasswordProblem,
	RESET_PAGE_PATH,
	type RevokedCredential,
	readResetLink,
	requestPasswordReset,
	submitPasswordReset,
} from "../lib/password-reset.ts";
import { AuthShell } from "./Login.tsx";

const REVOKED_LABELS: Record<RevokedCredential, () => string> = {
	accessTokens: m.reset_done_removed_access_tokens,
	calendarFeeds: m.reset_done_removed_calendar_feeds,
	passkeys: m.reset_done_removed_passkeys,
	linkedAccounts: m.reset_done_removed_linked_accounts,
};

type Stage =
	| { kind: "request"; invalidLink: boolean }
	| { kind: "set"; token: string }
	| { kind: "done"; revoked: RevokedCredential[] };

function initialStage(): Stage {
	const link = readResetLink(window.location.search);
	if (link.kind === "token") return { kind: "set", token: link.token };
	return { kind: "request", invalidLink: link.kind === "invalid" };
}

function Alert({ children }: { children: string }) {
	return (
		<p
			role="alert"
			className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
		>
			{children}
		</p>
	);
}

function BackToSignIn() {
	return (
		<p className="mt-6 text-center text-sm">
			<a
				data-testid="reset-back-to-sign-in"
				href="/"
				className="inline-flex min-h-11 items-center underline underline-offset-4"
			>
				{m.reset_back_to_sign_in()}
			</a>
		</p>
	);
}

export function ResetPassword() {
	const [stage, setStage] = useState(initialStage);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [sent, setSent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);

	// The single-use token stays in memory only, out of history and reloads.
	useEffect(() => {
		if (window.location.search)
			window.history.replaceState(null, "", RESET_PAGE_PATH);
	}, []);

	async function run(action: () => Promise<void>, fallback: () => string) {
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

	function sendLink(event: FormEvent) {
		event.preventDefault();
		void run(async () => {
			const result = await requestPasswordReset(email);
			if (result.kind === "error") setError(result.message);
			else setSent(true);
		}, m.reset_request_failed);
	}

	function setNewPassword(event: FormEvent, token: string) {
		event.preventDefault();
		const problem = newPasswordProblem(password, confirmation);
		if (problem) {
			setError(problem);
			return;
		}
		void run(async () => {
			const result = await submitPasswordReset(token, password);
			if (result.kind === "done") {
				setPassword("");
				setConfirmation("");
				setStage(result);
			} else if (result.kind === "invalid") {
				setStage({ kind: "request", invalidLink: true });
			} else setError(result.message);
		}, m.reset_failed);
	}

	if (stage.kind === "done")
		return (
			<AuthShell>
				<div data-testid="reset-done" className="space-y-4">
					<h1 className="text-lg font-semibold">{m.reset_done_title()}</h1>
					<p className="text-sm leading-6" role="status">
						{m.reset_done_signed_out()}
					</p>
					{stage.revoked.length > 0 && (
						<div className="text-sm leading-6">
							<p>{m.reset_done_removed_heading()}</p>
							<ul
								data-testid="reset-removed"
								className="mt-1 list-disc ps-5 text-muted-foreground"
							>
								{stage.revoked.map((key) => (
									<li key={key}>{REVOKED_LABELS[key]()}</li>
								))}
							</ul>
						</div>
					)}
					<p className="text-sm leading-6 text-muted-foreground">
						{m.reset_done_two_factor()}
					</p>
					<Button
						data-testid="reset-sign-in"
						type="button"
						className="h-11 w-full"
						onClick={() => window.location.assign("/")}
					>
						{m.login_signin()}
					</Button>
				</div>
			</AuthShell>
		);

	if (stage.kind === "set") {
		const token = stage.token;
		return (
			<AuthShell>
				<h1 className="mb-6 text-lg font-semibold">{m.reset_new_title()}</h1>
				<form
					className="space-y-3"
					onSubmit={(event) => setNewPassword(event, token)}
				>
					<div className="space-y-2">
						<label htmlFor="reset-new-password" className="text-sm font-medium">
							{m.reset_new_password_label()}
						</label>
						<Input
							id="reset-new-password"
							data-testid="reset-new-password"
							type="password"
							autoComplete="new-password"
							minLength={PASSWORD_MIN_LENGTH}
							maxLength={PASSWORD_MAX_LENGTH}
							aria-describedby="reset-password-guidance"
							className="h-11"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							disabled={pending}
							required
						/>
						<p
							id="reset-password-guidance"
							className="text-xs leading-5 text-muted-foreground"
						>
							{m.login_password_guidance({
								min: PASSWORD_MIN_LENGTH,
								max: PASSWORD_MAX_LENGTH,
							})}
						</p>
					</div>
					<div className="space-y-2">
						<label
							htmlFor="reset-confirm-password"
							className="text-sm font-medium"
						>
							{m.reset_confirm_password_label()}
						</label>
						<Input
							id="reset-confirm-password"
							data-testid="reset-confirm-password"
							type="password"
							autoComplete="new-password"
							maxLength={PASSWORD_MAX_LENGTH}
							className="h-11"
							value={confirmation}
							onChange={(event) => setConfirmation(event.target.value)}
							disabled={pending}
							required
						/>
					</div>
					{error && <Alert>{error}</Alert>}
					<Button
						data-testid="reset-submit"
						type="submit"
						className="h-11 w-full"
						disabled={pending}
					>
						{m.reset_submit()}
					</Button>
				</form>
				<BackToSignIn />
			</AuthShell>
		);
	}

	return (
		<AuthShell>
			<h1 className="mb-2 text-lg font-semibold">{m.reset_request_title()}</h1>
			<p className="mb-6 text-sm leading-6 text-muted-foreground">
				{m.reset_request_description()}
			</p>
			{stage.invalidLink && (
				<div className="mb-4" data-testid="reset-link-invalid">
					<Alert>{m.reset_link_invalid()}</Alert>
				</div>
			)}
			<form className="space-y-3" onSubmit={sendLink}>
				<div className="space-y-2">
					<label htmlFor="reset-email" className="text-sm font-medium">
						{m.login_email_label()}
					</label>
					<Input
						id="reset-email"
						data-testid="reset-email"
						type="email"
						autoComplete="email"
						className="h-11"
						value={email}
						onChange={(event) => {
							setEmail(event.target.value);
							setSent(false);
						}}
						disabled={pending}
						required
					/>
				</div>
				{sent && (
					<p
						data-testid="reset-request-sent"
						role="status"
						className="text-sm text-muted-foreground"
					>
						{m.reset_request_sent()}
					</p>
				)}
				{error && <Alert>{error}</Alert>}
				<Button
					data-testid="reset-request-submit"
					type="submit"
					className="h-11 w-full"
					disabled={pending}
				>
					{m.reset_request_submit()}
				</Button>
			</form>
			<BackToSignIn />
		</AuthShell>
	);
}
