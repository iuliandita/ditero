import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { authClient } from "./lib/auth-client.ts";
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
	if (isPending) return null;
	if (!session) return <Login />;
	return (
		<AppZeroProvider userID={session.user.id}>
			<Workspace />
		</AppZeroProvider>
	);
}
