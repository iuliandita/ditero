import { useEffect, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import {
	type NativeNotificationOpen,
	type NativeNotificationTarget,
	useNativeAccount,
} from "../lib/native-account.tsx";

/** Server resolution never bypasses the shell's current synced visibility rules. */
export function useNativeNotificationNavigation(
	ready: boolean,
	open: (target: NativeNotificationTarget) => boolean,
) {
	const navigation = useNativeAccount()?.notifications;
	const { show } = useSnackbar();
	const [pending, setPending] = useState<
		(NativeNotificationOpen & { identity: string; revision: number }) | null
	>(null);
	const currentOpen = useRef(open);
	currentOpen.current = open;
	const consumed = useRef<string | null>(null);
	const readRevision = useRef(0);

	useEffect(() => {
		setPending(null);
		consumed.current = null;
		if (!navigation) return;
		let alive = true;
		let reading = false;
		let requested = false;
		const read = async () => {
			if (!alive) return;
			const revision = ++readRevision.current;
			setPending(null);
			if (reading) {
				requested = true;
				return;
			}
			reading = true;
			try {
				const next = await navigation.read();
				if (
					alive &&
					revision === readRevision.current &&
					next?.token !== consumed.current
				)
					setPending(
						next ? { ...next, identity: navigation.identity, revision } : null,
					);
			} catch (error) {
				if (!alive || revision !== readRevision.current) return;
				const code =
					error instanceof Error && "code" in error ? error.code : null;
				if (
					[
						"unauthorized",
						"no-session",
						"stale-generation",
						"cancelled",
					].includes(String(code))
				)
					return;
				show({
					message:
						code === "notification-unavailable"
							? m.native_notification_unavailable()
							: m.native_connect_failed(),
					action:
						code === "notification-unavailable"
							? undefined
							: {
									label: m.action_retry(),
									run: () => {
										void read();
									},
								},
				});
			} finally {
				reading = false;
				if (requested && alive) {
					requested = false;
					void read();
				}
			}
		};
		const unsubscribe = navigation.subscribe(() => {
			void read();
		});
		void read();
		return () => {
			alive = false;
			unsubscribe();
		};
	}, [navigation, show]);

	useEffect(() => {
		if (
			!navigation ||
			!ready ||
			!pending ||
			pending.identity !== navigation.identity ||
			pending.revision !== readRevision.current ||
			consumed.current === pending.token
		)
			return;
		consumed.current = pending.token;
		const opened = currentOpen.current(pending.target);
		if (!opened) show({ message: m.native_notification_unavailable() });
		// Dismiss only after the selected shell has accepted or refused this target.
		void navigation.dismiss(pending.token).catch(() => {
			console.error("Could not dismiss native notification");
		});
		setPending(null);
	}, [navigation, pending, ready, show]);
}
