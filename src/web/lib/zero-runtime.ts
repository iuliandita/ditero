import type { PublicConfig } from "../../server/public-config.ts";
import { fetchPublicConfig } from "./public-config.ts";
import { fetchZeroToken } from "./zero-auth.ts";

type ZeroRuntimeOperations = {
	bootstrap(): Promise<void>;
	fetchConfig(): Promise<PublicConfig>;
	getAuth(): Promise<string>;
};

export type BrowserZeroRuntime = ZeroRuntimeOperations & {
	kind: "browser";
	storageScope?: undefined;
};

// getAuth is an opaque native handle, never a JWT. storageScope must come from
// a verified native instance/account adapter and never from caller input.
export type NativeZeroRuntime = ZeroRuntimeOperations & {
	kind: "native";
	storageScope: string;
};

export type ZeroRuntime = BrowserZeroRuntime | NativeZeroRuntime;

async function repairAccountBootstrap(): Promise<void> {
	const res = await fetch("/api/bootstrap", {
		method: "POST",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`account bootstrap failed: ${res.status}`);
}

export const browserZeroRuntime: BrowserZeroRuntime = {
	kind: "browser",
	bootstrap: repairAccountBootstrap,
	fetchConfig: fetchPublicConfig,
	getAuth: fetchZeroToken,
};

// Browser storage stays keyed by the canonical userID alone.
export function zeroStorageScope(runtime: ZeroRuntime): string | undefined {
	if (runtime.kind === "browser") return undefined;
	if (typeof runtime.storageScope !== "string" || !runtime.storageScope.trim())
		throw new Error("native Zero runtime has no storage scope");
	return runtime.storageScope;
}
