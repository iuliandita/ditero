import { useZero } from "@rocicorp/zero/react";
import { createContext, useContext } from "react";

export type NativeAccount = {
	profile: { id: string; name: string; email: string };
	origin: string;
	storageScope: string;
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
