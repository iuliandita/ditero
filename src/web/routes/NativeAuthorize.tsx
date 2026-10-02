import { type ReactNode, useEffect, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { Button } from "../components/ui/button.tsx";
import type { authClient } from "../lib/auth-client.ts";
import { AuthShell, Login } from "./Login.tsx";

// Browser consent for `/native/authorize?grantId=`. The native app opens this
// in the system browser; the signed-in user reviews the device and explicitly
// allows it. Nothing here approves on load, and nothing is stored or logged.

type Session = ReturnType<typeof authClient.useSession>["data"];

type View =
	| { kind: "loading" }
	| { kind: "pending"; deviceLabel: string }
	| { kind: "approved" }
	| { kind: "invalid" }
	| { kind: "signin" }
	| { kind: "error" };

// 32 random bytes as base64url without padding: 43 chars, and the last one
// carries only 4 bits, so it must be a multiple of 4 in the alphabet.
const GRANT_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

function grantIdFromLocation(): string | null {
	const ids = new URLSearchParams(window.location.search).getAll("grantId");
	return ids.length === 1 && GRANT_ID.test(ids[0]) ? ids[0] : null;
}

function parsePreview(data: unknown): View {
	if (typeof data !== "object" || data === null) return { kind: "error" };
	const { deviceLabel, expiresAt, state } = data as Record<string, unknown>;
	if (
		typeof deviceLabel !== "string" ||
		typeof expiresAt !== "string" ||
		Number.isNaN(Date.parse(expiresAt))
	)
		return { kind: "error" };
	if (state === "approved") return { kind: "approved" };
	if (state === "pending") return { kind: "pending", deviceLabel };
	return { kind: "error" };
}

export function NativeAuthorize({
	session,
	isPending,
}: {
	session: Session;
	isPending: boolean;
}) {
	const grantId = grantIdFromLocation();
	if (!grantId) return <Invalid />;
	if (isPending)
		return (
			<AuthShell>
				<p role="status" className="text-sm leading-6 text-muted-foreground">
					{m.native_authorize_loading()}
				</p>
			</AuthShell>
		);
	// The return URL is rebuilt from the origin, the literal path, and the
	// validated id, never from caller input.
	if (!session)
		return (
			<Login
				callbackURL={`${window.location.origin}/native/authorize?grantId=${grantId}`}
			/>
		);
	return (
		<Consent
			key={`${session.user.id}:${grantId}`}
			grantId={grantId}
			name={session.user.name}
			email={session.user.email}
		/>
	);
}

function Panel({
	title,
	children,
	testId,
}: {
	title: string;
	children: ReactNode;
	testId: string;
}) {
	return (
		<AuthShell>
			<div data-testid={testId} className="space-y-4">
				<h1 className="text-lg font-semibold">{title}</h1>
				{children}
			</div>
		</AuthShell>
	);
}

function Invalid() {
	return (
		<Panel
			testId="native-authorize-invalid"
			title={m.native_authorize_invalid_title()}
		>
			<p role="alert" className="text-sm leading-6 text-muted-foreground">
				{m.native_authorize_invalid_body()}
			</p>
			<a
				href="/"
				className="inline-flex min-h-12 items-center rounded-sm text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				{m.native_authorize_go_home()}
			</a>
		</Panel>
	);
}

function Consent({
	grantId,
	name,
	email,
}: {
	grantId: string;
	name: string;
	email: string;
}) {
	const [view, setView] = useState<View>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [submitting, setSubmitting] = useState(false);
	const [approveFailed, setApproveFailed] = useState(false);
	const submittingRef = useRef(false);
	const approveAbort = useRef<AbortController | null>(null);

	useEffect(() => {
		// `attempt` re-runs the preview when the user presses retry.
		void attempt;
		const controller = new AbortController();
		setView({ kind: "loading" });
		(async () => {
			try {
				const res = await fetch(
					`/api/native/grants/preview?grantId=${encodeURIComponent(grantId)}`,
					{ credentials: "include", signal: controller.signal },
				);
				let next: View;
				if (res.status === 200)
					next = parsePreview(await res.json().catch(() => null));
				else if (res.status === 401) next = { kind: "signin" };
				else if (res.status === 404 || res.status === 400)
					next = { kind: "invalid" };
				else next = { kind: "error" };
				if (!controller.signal.aborted) setView(next);
			} catch {
				if (!controller.signal.aborted) setView({ kind: "error" });
			}
		})();
		return () => controller.abort();
	}, [grantId, attempt]);

	useEffect(() => () => approveAbort.current?.abort(), []);

	async function approve() {
		if (submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setApproveFailed(false);
		const controller = new AbortController();
		approveAbort.current = controller;
		try {
			const res = await fetch("/api/native/grants/approve", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ grantId }),
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			if (res.status === 200) {
				const data = (await res.json().catch(() => null)) as {
					approved?: unknown;
				} | null;
				if (data?.approved === true) setView({ kind: "approved" });
				else setApproveFailed(true);
			} else if (res.status === 400) setView({ kind: "invalid" });
			else if (res.status === 401) setView({ kind: "signin" });
			else setApproveFailed(true);
		} catch {
			if (!controller.signal.aborted) setApproveFailed(true);
		} finally {
			submittingRef.current = false;
			if (!controller.signal.aborted) setSubmitting(false);
		}
	}

	if (view.kind === "loading")
		return (
			<AuthShell>
				<p role="status" className="text-sm leading-6 text-muted-foreground">
					{m.native_authorize_loading()}
				</p>
			</AuthShell>
		);
	if (view.kind === "invalid") return <Invalid />;
	if (view.kind === "approved")
		return (
			<Panel
				testId="native-authorize-approved"
				title={m.native_authorize_approved_title()}
			>
				<p role="status" className="text-sm leading-6 text-muted-foreground">
					{m.native_authorize_approved_body()}
				</p>
			</Panel>
		);
	if (view.kind === "signin")
		return (
			<Panel
				testId="native-authorize"
				title={m.native_authorize_signin_title()}
			>
				<p role="alert" className="text-sm leading-6 text-muted-foreground">
					{m.native_authorize_signin_body()}
				</p>
				<Button
					type="button"
					variant="outline"
					className="h-auto min-h-12 w-full whitespace-normal py-2"
					onClick={() => window.location.reload()}
				>
					{m.native_authorize_reload()}
				</Button>
			</Panel>
		);
	if (view.kind === "error")
		return (
			<Panel testId="native-authorize" title={m.native_authorize_error_title()}>
				<p role="alert" className="text-sm leading-6 text-muted-foreground">
					{m.native_authorize_error_body()}
				</p>
				<Button
					data-testid="native-authorize-retry"
					type="button"
					variant="outline"
					className="h-auto min-h-12 w-full whitespace-normal py-2"
					onClick={() => setAttempt((n) => n + 1)}
				>
					{m.native_authorize_retry()}
				</Button>
			</Panel>
		);

	const rows: [string, string][] = [
		[m.native_authorize_device_label(), view.deviceLabel],
		[m.native_authorize_account_label(), name],
		[m.native_authorize_email_label(), email],
		[m.native_authorize_server_label(), window.location.host],
	];
	return (
		<Panel testId="native-authorize" title={m.native_authorize_title()}>
			<dl className="space-y-3 text-sm leading-6">
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt className="text-muted-foreground">{label}</dt>
						<dd className="font-medium break-words">
							<bdi>{value}</bdi>
						</dd>
					</div>
				))}
			</dl>
			<p className="text-sm leading-6">{m.native_authorize_access()}</p>
			<p className="text-sm leading-6 text-muted-foreground">
				{m.native_authorize_only_if_started()}
			</p>
			{approveFailed ? (
				<p
					role="alert"
					className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
				>
					{m.native_authorize_approve_failed()}
				</p>
			) : null}
			<div className="space-y-2" aria-busy={submitting}>
				<Button
					data-testid="native-authorize-allow"
					type="button"
					className="h-auto min-h-12 w-full whitespace-normal py-2"
					disabled={submitting}
					onClick={() => void approve()}
				>
					{submitting
						? m.native_authorize_allowing()
						: m.native_authorize_allow()}
				</Button>
				<Button
					data-testid="native-authorize-cancel"
					type="button"
					variant="outline"
					className="h-auto min-h-12 w-full whitespace-normal py-2"
					disabled={submitting}
					onClick={() => window.location.assign("/")}
				>
					{m.native_authorize_cancel()}
				</Button>
			</div>
		</Panel>
	);
}
