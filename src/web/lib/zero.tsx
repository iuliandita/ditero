import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";

// Fetch a fresh JWT from Better Auth. In v1.7 the Zero client `auth` option is a
// token string (not a callback), so the token is resolved before construction.
async function fetchToken(): Promise<string> {
	const res = await fetch("/api/auth/token", { credentials: "include" });
	if (!res.ok) return "";
	const body = (await res.json()) as { token?: string };
	return body.token ?? "";
}

// Client-side context ({ id }) is passed for optimistic synced-query evaluation;
// the server re-derives the authoritative ctx from the JWT. Let TS infer the full
// Zero generic from the constructor rather than restating it.
function createZeroClient(userID: string, token: string) {
	return new Zero({
		cacheURL: import.meta.env.VITE_ZERO_URL ?? "http://localhost:4848",
		userID,
		schema,
		mutators,
		auth: token,
		context: { id: userID },
	});
}
type ZeroClient = ReturnType<typeof createZeroClient>;

export function AppZeroProvider({
	userID,
	children,
}: {
	userID: string;
	children: ReactNode;
}) {
	const [zero, setZero] = useState<ZeroClient | null>(null);

	useEffect(() => {
		let instance: ZeroClient | undefined;
		let cancelled = false;
		void (async () => {
			const token = await fetchToken();
			if (cancelled) return;
			instance = createZeroClient(userID, token);
			setZero(instance);
		})();
		return () => {
			cancelled = true;
			instance?.close();
			setZero(null);
		};
	}, [userID]);

	if (!zero) return null;
	return <ZeroProvider zero={zero}>{children}</ZeroProvider>;
}
