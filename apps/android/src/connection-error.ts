import { m } from "../../../src/paraglide/messages.js";
import { NativeError } from "./bridge.ts";

export function connectionErrorMessage(
	error: unknown,
	desktopRestore: boolean,
): string {
	return desktopRestore &&
		error instanceof NativeError &&
		error.code === "network"
		? m.native_desktop_online_start_required()
		: m.native_connect_failed();
}
