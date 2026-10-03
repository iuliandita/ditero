import type { ReactNode } from "react";
import { BootSkeleton } from "./components/shell/AppSkeleton.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { SnackbarProvider } from "./components/ui/snackbar.tsx";
import { useUserPref } from "./hooks/useUserPref.ts";
import { authClient } from "./lib/auth-client.ts";
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
	const { data: session, isPending } = authClient.useSession();
	return <SessionRoutes session={session} isPending={isPending} />;
}

function SessionRoutes({
	session,
	isPending,
}: {
	session: ReturnType<typeof authClient.useSession>["data"];
	isPending: boolean;
}) {
	const userId = isPending ? null : (session?.user.id ?? null);
	const standalone = (children: ReactNode) => (
		<DisplayPreferencesProvider key={userId ?? "logged-out"} userId={userId}>
			{children}
		</DisplayPreferencesProvider>
	);
	// Standalone redemption route: no router, but `/accept?token=` must render for
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
	if (!session) return standalone(<Login />);
	return (
		<AppZeroProvider key={session.user.id} userID={session.user.id}>
			<SyncedDisplayPreferencesProvider
				key={session.user.id}
				userId={session.user.id}
			>
				<KeyringGate userId={session.user.id} />
			</SyncedDisplayPreferencesProvider>
		</AppZeroProvider>
	);
}

// Inside AppZeroProvider because the auto-lock preference is a synced row, and
// above Workspace because the keyring outlives any one surface: a key unlocked
// for an attachment must still be unlocked when the user navigates away.
function KeyringGate({ userId }: { userId: string }) {
	const { pref } = useUserPref();
	return (
		<KeyringProvider userId={userId} autoLockMinutes={pref.e2eAutoLockMinutes}>
			<Workspace />
		</KeyringProvider>
	);
}
