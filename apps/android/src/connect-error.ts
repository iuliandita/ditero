import { m } from "../../../src/paraglide/messages.js";
import {
	retirementErrorMessage,
	ZeroRetirementError,
} from "../../../src/web/lib/zero-lifecycle.ts";
import { NativeError } from "./bridge.ts";

export function connectErrorMessage(
	error: unknown,
	desktopRestore = false,
): string {
	if (error instanceof ZeroRetirementError)
		return retirementErrorMessage(error);
	if (error instanceof NativeError) {
		if (desktopRestore && error.code === "network")
			return m.native_desktop_online_start_required();
		switch (error.code) {
			case "https-required":
				return m.native_connect_https_required();
			case "server-not-found":
				return m.native_connect_server_not_found();
			case "certificate-not-trusted":
				return m.native_connect_certificate_not_trusted();
			case "network":
			case "server-unreachable":
				return m.native_connect_unreachable();
		}
	}
	return m.native_connect_failed();
}
