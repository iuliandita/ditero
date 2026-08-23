import { BootSkeleton } from "./components/shell/AppSkeleton.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { useUserPref } from "./hooks/useUserPref.ts";
import { authClient } from "./lib/auth-client.ts";
import { KeyringProvider } from "./lib/e2e/KeyringProvider.tsx";
import { AppZeroProvider } from "./lib/zero.tsx";
import { AcceptInvite } from "./routes/AcceptInvite.tsx";
import { Login } from "./routes/Login.tsx";
import { Workspace } from "./routes/Workspace.tsx";

// The provider sits above every route because Workspace itself calls useConfirm
// and renders AppShell, so mounting it inside the shell would be out of scope
// for its own caller.
export function App() {
	return (
		<ConfirmProvider>
			<Routes />
		</ConfirmProvider>
	);
}

function Routes() {
	const { data: session, isPending } = authClient.useSession();
	// Standalone redemption route: no router, but `/accept?token=` must render for
	// both logged-out and logged-in invitees. AcceptInvite runs its own session +
	// preview logic; every other path stays on the normal session-gated flow.
	if (window.location.pathname === "/accept") return <AcceptInvite />;
	if (isPending) return <BootSkeleton />;
	if (!session) return <Login />;
	return (
		<AppZeroProvider userID={session.user.id}>
			<KeyringGate userId={session.user.id} />
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
