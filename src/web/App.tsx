import { authClient } from "./lib/auth-client.ts";
import { AppZeroProvider } from "./lib/zero.tsx";
import { Login } from "./routes/Login.tsx";
import { Workspace } from "./routes/Workspace.tsx";

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <Login />;
  return (
    <AppZeroProvider userID={session.user.id}>
      <Workspace />
    </AppZeroProvider>
  );
}
