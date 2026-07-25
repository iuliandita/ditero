import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "../../paraglide/messages.js";
import { authClient } from "../lib/auth-client.ts";
import { signInEmail } from "../lib/email-sign-in.ts";

// Client accept page for `/accept?token=`. An invitee landing here previews the
// invite (unauthenticated), then redeems it: a signed-in invitee just joins; a
// logged-out invitee signs up (or signs in) first, after which the page accepts
// automatically. Success redirects to "/" so the app boots with the new
// membership. It never leaks invite internals -- an invalid/expired/used/revoked
// token surfaces one neutral message.

type Preview =
	| { state: "loading" }
	| { state: "invalid" }
	| { state: "valid"; workspaceName: string; email: string | null };

function tokenFromLocation(): string | null {
	return new URLSearchParams(window.location.search).get("token");
}

// Map the accept endpoint's 4xx into one friendly line; never echo the raw reason.
// The reasons stay the server's invite-state values -- only the lines resolve.
function acceptMessage(status: number, reason: string): string {
	if (status === 401) return m.accept_error_sign_in_required();
	if (status === 404) return m.accept_error_invalid();
	if (reason === "expired") return m.accept_error_expired();
	if (reason === "exhausted") return m.accept_error_exhausted();
	if (reason === "revoked") return m.accept_error_revoked();
	return m.accept_error_generic();
}

export function AcceptInvite() {
	const { data: session, isPending } = authClient.useSession();
	const [token] = useState(tokenFromLocation);
	const [preview, setPreview] = useState<Preview>({ state: "loading" });
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [mode, setMode] = useState<"signup" | "signin">("signup");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const emailId = useId();
	const passwordId = useId();

	useEffect(() => {
		if (!token) {
			setPreview({ state: "invalid" });
			return;
		}
		let active = true;
		(async () => {
			try {
				const res = await fetch(
					`/api/invite/preview?token=${encodeURIComponent(token)}`,
				);
				const data = (await res.json().catch(() => ({}))) as {
					valid?: boolean;
					workspaceName?: string;
					email?: string | null;
				};
				if (!active) return;
				if (res.ok && data.valid && data.workspaceName) {
					setPreview({
						state: "valid",
						workspaceName: data.workspaceName,
						email: data.email ?? null,
					});
					if (data.email) setEmail(data.email);
				} else {
					setPreview({ state: "invalid" });
				}
			} catch {
				if (active) setPreview({ state: "invalid" });
			}
		})();
		return () => {
			active = false;
		};
	}, [token]);

	async function doAccept(): Promise<void> {
		if (!token) return;
		const res = await fetch("/api/invite/accept", {
			method: "POST",
			credentials: "include",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		if (res.ok) {
			window.location.assign("/");
			return;
		}
		const reason = (await res.text().catch(() => "")).trim();
		setError(acceptMessage(res.status, reason));
	}

	async function join(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await doAccept();
		} finally {
			setBusy(false);
		}
	}

	async function authThenAccept(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			if (mode === "signup") {
				const name = email.split("@")[0] || email;
				const res = await authClient.signUp.email({ email, password, name });
				if (res.error) {
					setError(res.error.message ?? m.accept_signup_failed());
					return;
				}
			} else {
				const result = await signInEmail(email, password);
				if (result.kind === "error") {
					setError(result.message);
					return;
				}
				if (result.kind === "two-factor") {
					setError(m.accept_two_factor_hint());
					return;
				}
			}
			// Auth succeeded and set the session cookie; redeem in the same flow.
			await doAccept();
		} finally {
			setBusy(false);
		}
	}

	if (preview.state === "loading" || isPending) {
		return (
			<div className="mx-auto flex max-w-sm flex-col gap-3 p-6">
				<p className="text-sm text-muted-foreground">{m.accept_loading()}</p>
			</div>
		);
	}

	if (preview.state === "invalid") {
		return (
			<div
				data-testid="accept-invalid"
				className="mx-auto flex max-w-sm flex-col gap-3 p-6"
			>
				<h1 className="text-lg font-semibold">{m.accept_invalid_title()}</h1>
				<p className="text-sm text-muted-foreground">
					{m.accept_invalid_body()}
				</p>
				<a
					href="/"
					className="text-sm text-primary underline-offset-4 hover:underline"
				>
					{m.accept_go_home()}
				</a>
			</div>
		);
	}

	return (
		<div
			data-testid="accept-page"
			className="mx-auto flex max-w-sm flex-col gap-4 p-6"
		>
			<div className="flex flex-col gap-1">
				<h1 className="text-lg font-semibold">{m.accept_title()}</h1>
				{/* One sentence, one message: the workspace name is a placeholder, so
				    the emphasis span the English layout had cannot survive translation. */}
				<p
					data-testid="accept-join-line"
					className="text-sm text-muted-foreground"
				>
					{m.accept_join_line({ workspace: preview.workspaceName })}
				</p>
			</div>

			{session ? (
				<div className="flex flex-col gap-3">
					<Button
						type="button"
						data-testid="accept-join"
						disabled={busy}
						onClick={() => void join()}
					>
						{m.accept_join_button({ workspace: preview.workspaceName })}
					</Button>
				</div>
			) : (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						void authThenAccept();
					}}
				>
					<div className="flex flex-col gap-1.5">
						<label htmlFor={emailId} className="text-sm font-medium">
							{m.field_email()}
						</label>
						<Input
							id={emailId}
							data-testid="accept-email"
							type="email"
							autoComplete="email"
							placeholder={m.email_placeholder()}
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<label htmlFor={passwordId} className="text-sm font-medium">
							{m.field_password()}
						</label>
						<Input
							id={passwordId}
							data-testid="accept-password"
							type="password"
							autoComplete={
								mode === "signup" ? "new-password" : "current-password"
							}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
					</div>
					<Button type="submit" data-testid="accept-submit" disabled={busy}>
						{mode === "signup"
							? m.accept_submit_signup()
							: m.accept_submit_signin()}
					</Button>
					<button
						type="button"
						data-testid="accept-mode-toggle"
						className="self-start text-sm text-primary underline-offset-4 hover:underline"
						onClick={() => {
							setMode((cur) => (cur === "signup" ? "signin" : "signup"));
							setError(null);
						}}
					>
						{mode === "signup"
							? m.accept_toggle_to_signin()
							: m.accept_toggle_to_signup()}
					</button>
				</form>
			)}

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
