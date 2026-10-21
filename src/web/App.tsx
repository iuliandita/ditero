import { type ReactNode, useEffect, useRef, useState } from "react";
import { settingsSectionFromPath } from "../domain/native-settings.ts";
import { m } from "../paraglide/messages.js";
import { BootSkeleton } from "./components/shell/AppSkeleton.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { SnackbarProvider } from "./components/ui/snackbar.tsx";
import { useUserPref } from "./hooks/useUserPref.ts";
import { authClient } from "./lib/auth-client.ts";
import {
	BROWSER_SESSION_CHANGED,
	BROWSER_SESSION_GENERATION_KEY,
	BROWSER_SESSION_KEY,
	canRestoreBrowserSession,
	isSessionRefusal,
	readBrowserSession,
} from "./lib/browser-session.ts";
import {
	DisplayPreferencesProvider,
	SyncedDisplayPreferencesProvider,
} from "./lib/DisplayPreferencesProvider.tsx";
import { KeyringProvider } from "./lib/e2e/KeyringProvider.tsx";
import { AppZeroProvider } from "./lib/zero.tsx";
import { AcceptInvite } from "./routes/AcceptInvite.tsx";
import { Login } from "./routes/Login.tsx";
import { NativeAuthorize } from "./routes/NativeAuthorize.tsx";
import { Workspace } from "./routes/Workspace.tsx";

// The provider sits above every route because Workspace itself calls useConfirm
// and renders AppShell, so mounting it inside the shell would be out of scope
// for its own caller.
export function App() {
	return (
		<ConfirmProvider>
			<SnackbarProvider>
				<Routes />
			</SnackbarProvider>
		</ConfirmProvider>
	);
}

function Routes() {
	const { data: session, isPending, error, refetch } = authClient.useSession();
	const [identity, setIdentity] = useState(readBrowserSession);
	const [online, setOnline] = useState(navigator.onLine);
	const [, tick] = useState(0);
	const lastError = useRef<unknown>(undefined);
	const failedOffline = useRef(false);
	if (lastError.current !== error) {
		lastError.current = error;
		failedOffline.current = error instanceof TypeError && !navigator.onLine;
	}
	useEffect(() => {
		const changed = () => setIdentity(readBrowserSession());
		const storage = (event: StorageEvent) => {
			if (
				event.key === BROWSER_SESSION_KEY ||
				event.key === BROWSER_SESSION_GENERATION_KEY ||
				event.key === null
			)
				changed();
		};
		const connected = () => {
			setOnline(true);
			void refetch({ query: { disableCookieCache: true } });
		};
		const disconnected = () => setOnline(false);
		window.addEventListener(BROWSER_SESSION_CHANGED, changed);
		window.addEventListener("storage", storage);
		window.addEventListener("online", connected);
		window.addEventListener("offline", disconnected);
		return () => {
			window.removeEventListener(BROWSER_SESSION_CHANGED, changed);
			window.removeEventListener("storage", storage);
			window.removeEventListener("online", connected);
			window.removeEventListener("offline", disconnected);
		};
	}, [refetch]);

	useEffect(() => {
		if (!identity) return;
		let timer: ReturnType<typeof setTimeout>;
		const expire = () => {
			const remaining = identity.expiresAt - Date.now();
			if (remaining <= 0) tick((n) => n + 1);
			else timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
		};
		expire();
		return () => clearTimeout(timer);
	}, [identity]);
	const offline = canRestoreBrowserSession({
		error: failedOffline.current ? error : null,
		identity,
		online,
		secure: window.isSecureContext,
	});
	return (
		<SessionRoutes
			session={error ? null : session}
			isPending={isPending}
			offlineUserId={offline ? identity?.userId : undefined}
			needsConnection={
				!isPending && !!error && !isSessionRefusal(error) && !offline
			}
			retry={() => void refetch({ query: { disableCookieCache: true } })}
		/>
	);
}

function SessionRoutes({
	session,
	isPending,
	offlineUserId,
	needsConnection,
	retry,
}: {
	session: ReturnType<typeof authClient.useSession>["data"];
	isPending: boolean;
	offlineUserId?: string;
	needsConnection: boolean;
	retry: () => void;
}) {
	const userId = isPending ? null : (session?.user.id ?? offlineUserId ?? null);
	const standalone = (children: ReactNode) => (
		<DisplayPreferencesProvider key={userId ?? "logged-out"} userId={userId}>
			{children}
		</DisplayPreferencesProvider>
	);
	// Standalone redemption route: no router, but `/accept#token=` must render for
	// both logged-out and logged-in invitees. AcceptInvite runs its own session +
	// preview logic; every other path stays on the normal session-gated flow.
	if (window.location.pathname === "/accept")
		return standalone(<AcceptInvite />);
	// Browser consent for a native sign-in: it only needs the session cookie, so
	// it never mounts Zero or the keyring.
	if (window.location.pathname === "/native/authorize")
		return standalone(
			<NativeAuthorize session={session} isPending={isPending} />,
		);
	if (isPending) return standalone(<BootSkeleton />);
	if (needsConnection)
		return standalone(
			<main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
				<p role="alert">{m.browser_connection_required()}</p>
				<button type="button" onClick={retry}>
					{m.action_retry()}
				</button>
			</main>,
		);
	if (!userId)
		return standalone(
			<Login
				callbackURL={
					window.location.pathname === "/setup" ||
					settingsSectionFromPath(window.location.pathname)
						? window.location.pathname
						: undefined
				}
			/>,
		);
	return (
		<AppZeroProvider key={userId} userID={userId} offline={!!offlineUserId}>
			{offlineUserId && (
				<aside
					role="status"
					data-testid="offline-session"
					className="border-b bg-background px-4 py-2 text-foreground"
				>
					{m.browser_cached_session()}
				</aside>
			)}
			<SyncedDisplayPreferencesProvider key={userId} userId={userId}>
				<KeyringGate userId={userId} profileEmail={session?.user.email ?? ""} />
			</SyncedDisplayPreferencesProvider>
		</AppZeroProvider>
	);
}

// Inside AppZeroProvider because the auto-lock preference is a synced row, and
// above Workspace because the keyring outlives any one surface: a key unlocked
// for an attachment must still be unlocked when the user navigates away.
function KeyringGate({
	userId,
	profileEmail,
}: {
	userId: string;
	profileEmail: string;
}) {
	const { pref } = useUserPref();
	return (
		<KeyringProvider userId={userId} autoLockMinutes={pref.e2eAutoLockMinutes}>
			<Workspace
				initialSetup={window.location.pathname === "/setup"}
				profileEmail={profileEmail}
			/>
		</KeyringProvider>
	);
}
