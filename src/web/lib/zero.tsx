import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { ShellSkeleton } from "../components/shell/AppSkeleton.tsx";
import { fetchPublicConfig } from "./public-config.ts";
import { fetchZeroToken, watchZeroAuth } from "./zero-auth.ts";

async function repairAccountBootstrap(): Promise<void> {
	const res = await fetch("/api/bootstrap", {
		method: "POST",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`account bootstrap failed: ${res.status}`);
}

// Client-side context ({ id }) is passed for optimistic synced-query evaluation;
// the server re-derives the authoritative ctx from the JWT. Let TS infer the full
// Zero generic from the constructor rather than restating it.
function createZeroClient(userID: string, token: string, cacheURL: string) {
	return new Zero({
		cacheURL,
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
		let stopAuthRefresh: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			await repairAccountBootstrap();
			const [config, token] = await Promise.all([
				fetchPublicConfig(),
				fetchZeroToken(),
			]);
			if (cancelled) return;
			instance = createZeroClient(userID, token, config.zeroURL);
			stopAuthRefresh = watchZeroAuth(instance);
			setZero(instance);
		})().catch((error) => {
			if (!cancelled) console.error("Zero startup failed", error);
		});
		return () => {
			cancelled = true;
			stopAuthRefresh?.();
			instance?.close();
			setZero(null);
		};
	}, [userID]);

	if (!zero) return <ShellSkeleton />;
	return <ZeroProvider zero={zero}>{children}</ZeroProvider>;
}
