import { useZero } from "@rocicorp/zero/react";
import { createContext, useContext } from "react";

export const NATIVE_PUSH_STATES = [
	"disabled",
	"enabling",
	"active",
	"denied",
	"missing-distributor",
	"server-unavailable",
	"registration-failed",
	"temporary-unavailable",
	"cleanup-pending",
	"storage-failed",
	"no-session",
] as const;
export type NativePushState = {
	state: (typeof NATIVE_PUSH_STATES)[number];
	permission: "granted" | "denied";
	provider: "unifiedpush";
};
export type NativePush = {
	readonly identity: string;
	read(): Promise<NativePushState>;
	enable(): Promise<NativePushState>;
	disable(): Promise<NativePushState>;
	permission(): Promise<NativePushState>;
};

export type NativeNotificationTarget =
	| { kind: "task"; workspaceId: string; listId: string; taskId: string }
	| { kind: "workspace"; workspaceId: string };
export type NativeNotificationOpen = {
	token: string;
	target: NativeNotificationTarget;
};
export type NativeNotificationNavigation = {
	readonly identity: string;
	read(): Promise<NativeNotificationOpen | null>;
	dismiss(token: string): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export type NativeAccount = {
	profile: { id: string; name: string; email: string };
	origin: string;
	storageScope: string;
	push?: NativePush;
	notifications?: NativeNotificationNavigation;
	changeServer(): Promise<void>;
};
export const NativeAccountContext = createContext<NativeAccount | null>(null);
export function useNativeAccount(): NativeAccount | null {
	return useContext(NativeAccountContext);
}

/** Local preferences use native server/account scope; Zero identity stays canonical. */
export function useAccountStorageScope(): string {
	const account = useNativeAccount();
	const zero = useZero();
	return account?.storageScope ?? zero.userID ?? "";
}
