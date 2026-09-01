import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	importRecipientPublicKey,
	publicKeyFingerprint,
	sealWdk,
} from "../../domain/e2e/hpke.ts";
import { openInviteFragment } from "../../domain/e2e/invite-fragment.ts";
import { verifyWdkCommitment } from "../../domain/e2e/wdk-commitment.ts";
import { decodeBytes, encodeBytes } from "../../domain/e2e/wire.ts";
import { m } from "../../paraglide/messages.js";
import { EnrollmentWizard } from "../components/e2e/EnrollmentWizard.tsx";
import { UnlockDialog } from "../components/e2e/UnlockDialog.tsx";
import { authClient } from "../lib/auth-client.ts";
import { authErrorMessage } from "../lib/auth-messages.ts";
import {
	type KeyringContextValue,
	KeyringProvider,
	useKeyring,
} from "../lib/e2e/KeyringProvider.tsx";
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

type StoredFastInvite = {
	payload: string;
	fragment: string | null;
	grant?: {
		requestId: string;
		recipientPublicKey: string;
		enc: string;
		ciphertext: string;
	};
};

type FastClaim = {
	inviteId: string;
	workspaceId: string;
	userId: string;
	intendedEmail: string;
	expiresAt: string;
	keyVersion: number;
	commitment: string;
	grantRequestId: string | null;
	grantState: "pending" | "ready";
};

const storageKey = (token: string) => `ditero:e2e-invite:${token}`;

/** Captures the bearer fragment synchronously, before the first paint/effect. */
export function captureFastInvite(
	token: string | null,
): StoredFastInvite | null {
	if (!token) return null;
	const url = new URL(window.location.href);
	const payload = url.searchParams.get("e2e");
	const fragment = new URLSearchParams(url.hash.slice(1)).get("e2e");
	let stored: StoredFastInvite | null = null;
	try {
		stored = JSON.parse(
			sessionStorage.getItem(storageKey(token)) ?? "null",
		) as StoredFastInvite | null;
	} catch {
		stored = null;
	}
	const captured = payload
		? {
				payload,
				fragment: fragment ?? stored?.fragment ?? null,
				...(stored?.grant ? { grant: stored.grant } : {}),
			}
		: stored;
	if (captured) {
		try {
			sessionStorage.setItem(storageKey(token), JSON.stringify(captured));
		} catch {
			// The current render still holds it. Storage is only reload resilience.
		}
	}
	if (url.hash) {
		url.hash = "";
		history.replaceState(history.state, "", `${url.pathname}${url.search}`);
	}
	return captured;
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
	if (session) {
		return (
			<KeyringProvider userId={session.user.id} autoLockMinutes={null}>
				<AuthenticatedAcceptInvite
					userId={session.user.id}
					isPending={isPending}
				/>
			</KeyringProvider>
		);
	}
	return (
		<AcceptInvitePage userId={null} isPending={isPending} keyring={null} />
	);
}

function AuthenticatedAcceptInvite({
	userId,
	isPending,
}: {
	userId: string;
	isPending: boolean;
}) {
	return (
		<AcceptInvitePage
			userId={userId}
			isPending={isPending}
			keyring={useKeyring()}
		/>
	);
}

function AcceptInvitePage({
	userId,
	isPending,
	keyring,
}: {
	userId: string | null;
	isPending: boolean;
	keyring: KeyringContextValue | null;
}) {
	const [token] = useState(tokenFromLocation);
	const [fastInvite] = useState(() => captureFastInvite(tokenFromLocation()));
	const [preview, setPreview] = useState<Preview>({ state: "loading" });
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [mode, setMode] = useState<"signup" | "signin">("signup");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [fastClaim, setFastClaim] = useState<FastClaim | null>(null);
	const [fastWdk, setFastWdk] = useState<Uint8Array | null>(null);
	const [fastGrant, setFastGrant] = useState(fastInvite?.grant ?? null);
	const [enrollOpen, setEnrollOpen] = useState(false);
	const [unlockOpen, setUnlockOpen] = useState(false);
	const completing = useRef(false);
	const autoStarted = useRef(false);
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

	const ordinaryAccept = useCallback(async (): Promise<void> => {
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
	}, [token]);

	const finalize = useCallback(
		async (mode: "fast" | "fallback"): Promise<boolean> => {
			if (!token) return false;
			let response: Response;
			try {
				response = await fetch("/api/invite/finalize", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token, mode }),
				});
			} catch {
				return false;
			}
			if (!response.ok) return false;
			try {
				sessionStorage.removeItem(storageKey(token));
			} catch {
				// The navigation drops the in-memory copy either way.
			}
			window.location.assign("/");
			return true;
		},
		[token],
	);

	const fallBackAfterClaim = useCallback(async (): Promise<void> => {
		if (!(await finalize("fallback"))) {
			setError(m.accept_error_generic());
		}
	}, [finalize]);

	const beginFastAccept = useCallback(async (): Promise<void> => {
		if (!token || !fastInvite || !keyring || completing.current) return;
		completing.current = true;
		setBusy(true);
		setError(null);
		try {
			// Makes a committed-finalize response loss idempotent: the endpoint
			// returns success to the same claimant even though preview is now invalid.
			// A fresh link has no durable grant to finalize, so skip the guaranteed
			// 409 probe and claim first.
			if (fastInvite.grant && (await finalize("fast"))) return;

			const response = await fetch("/api/invite/claim", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
			if (!response.ok) {
				const reason = (await response.text().catch(() => "")).trim();
				if (reason === "not_fast_eligible") {
					await ordinaryAccept();
				} else {
					setError(acceptMessage(response.status, reason));
				}
				return;
			}
			const claim = (await response.json()) as FastClaim;
			setFastClaim(claim);
			if (claim.grantState === "ready") {
				await finalize("fast");
				return;
			}
			if (!fastInvite.fragment) {
				await fallBackAfterClaim();
				return;
			}
			try {
				const wdk = await openInviteFragment(
					fastInvite.fragment,
					fastInvite.payload,
					claim,
				);
				await verifyWdkCommitment(
					wdk,
					claim.workspaceId,
					claim.keyVersion,
					claim.commitment,
				);
				setFastWdk(wdk);
			} catch {
				await fallBackAfterClaim();
			}
		} finally {
			completing.current = false;
			setBusy(false);
		}
	}, [
		fallBackAfterClaim,
		fastInvite,
		finalize,
		keyring,
		ordinaryAccept,
		token,
	]);

	useEffect(() => {
		if (!fastClaim || !fastWdk || !keyring?.ready || completing.current) return;
		if (keyring.state === "unenrolled") {
			setEnrollOpen(true);
			return;
		}
		if (keyring.state === "locked") {
			setUnlockOpen(true);
			return;
		}
		const grantRequestId = fastClaim.grantRequestId;
		const recipientPublicKey = keyring.identity?.publicKey;
		if (!grantRequestId || !recipientPublicKey) {
			void fallBackAfterClaim();
			return;
		}

		completing.current = true;
		setBusy(true);
		void (async () => {
			try {
				let grant = fastGrant;
				if (!grant || grant.requestId !== grantRequestId) {
					const publicKeyBytes = decodeBytes(recipientPublicKey);
					const sealed = await sealWdk(
						fastWdk,
						await importRecipientPublicKey(publicKeyBytes),
						{
							workspaceId: fastClaim.workspaceId,
							keyVersion: fastClaim.keyVersion,
							recipientUserId: fastClaim.userId,
							recipientFingerprint: await publicKeyFingerprint(publicKeyBytes),
						},
					);
					grant = {
						requestId: grantRequestId,
						recipientPublicKey,
						enc: encodeBytes(sealed.enc),
						ciphertext: encodeBytes(sealed.ciphertext),
					};
					setFastGrant(grant);
					try {
						sessionStorage.setItem(
							storageKey(token as string),
							JSON.stringify({ ...fastInvite, grant }),
						);
					} catch {
						// The live component still reuses this exact envelope.
					}
				}
				const response = await fetch("/api/invite/grant", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token, ...grant }),
				});
				if (!response.ok) {
					setError(m.accept_error_generic());
					return;
				}
				keyring.cacheWorkspaceKey(
					fastClaim.workspaceId,
					fastClaim.keyVersion,
					fastWdk,
				);
				if (!(await finalize("fast"))) setError(m.accept_error_generic());
			} catch {
				setError(m.accept_error_generic());
			} finally {
				completing.current = false;
				setBusy(false);
			}
		})();
	}, [
		fallBackAfterClaim,
		fastClaim,
		fastGrant,
		fastInvite,
		fastWdk,
		finalize,
		keyring,
		token,
	]);

	useEffect(() => {
		if (userId && fastInvite && keyring?.ready && !autoStarted.current) {
			autoStarted.current = true;
			void beginFastAccept();
		}
	}, [beginFastAccept, fastInvite, keyring?.ready, userId]);

	async function join(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			if (fastInvite) await beginFastAccept();
			else await ordinaryAccept();
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
					setError(authErrorMessage(res.error, m.accept_signup_failed));
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
			// Fast acceptance needs a keyring mounted for the now-authenticated user.
			// Reload preserves the captured fragment in tab storage, then the
			// authenticated effect resumes automatically.
			if (fastInvite) window.location.reload();
			else await ordinaryAccept();
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
		<>
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

				{userId ? (
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
			{userId && (
				<EnrollmentWizard
					open={enrollOpen}
					onOpenChange={setEnrollOpen}
					userId={userId}
					onEnrolled={() => setEnrollOpen(false)}
				/>
			)}
			{userId && (
				<UnlockDialog
					open={unlockOpen}
					onOpenChange={setUnlockOpen}
					userId={userId}
				/>
			)}
		</>
	);
}
