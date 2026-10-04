import { useEffect, useRef } from "react";
import { m } from "../../paraglide/messages.js";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import {
	type NativeTaskLinkNavigation,
	type NativeTaskLinkOpen,
	useNativeAccount,
} from "../lib/native-account.tsx";

/** Delivery remains memory-only and belongs to one mounted account. */
export function createTaskLinkDelivery(
	navigation: NativeTaskLinkNavigation,
	options: {
		current(): boolean;
		ready(): boolean;
		open(taskId: string): boolean;
		unavailable(): void;
		recovery(retry: () => void): void;
	},
) {
	let alive = true;
	let pending: NativeTaskLinkOpen | null = null;
	let consumed: string | null = null;
	let acknowledgement: string | null = null;
	let acknowledging = false;
	let reading = false;
	let requested = false;
	let revision = 0;
	const current = () => alive && options.current();
	const retired = (error: unknown) => {
		const code = error instanceof Error && "code" in error ? error.code : null;
		return [
			"unauthorized",
			"no-session",
			"stale-generation",
			"cancelled",
		].includes(String(code));
	};
	const acknowledge = async () => {
		if (!current() || !acknowledgement || acknowledging) return;
		const token = acknowledgement;
		acknowledging = true;
		try {
			for (let attempt = 0; attempt < 3 && current(); attempt++) {
				try {
					await navigation.dismiss(token);
					if (current() && acknowledgement === token) acknowledgement = null;
					return;
				} catch (error) {
					if (!current() || acknowledgement !== token) return;
					if (retired(error)) {
						acknowledgement = null;
						return;
					}
				}
			}
			if (current() && acknowledgement === token)
				options.recovery(() => {
					if (current() && acknowledgement === token) void acknowledge();
				});
		} finally {
			acknowledging = false;
			if (current() && acknowledgement && acknowledgement !== token)
				void acknowledge();
		}
	};
	const flush = () => {
		if (
			!current() ||
			!options.ready() ||
			!pending ||
			pending.token === consumed
		)
			return;
		const next = pending;
		pending = null;
		consumed = next.token;
		acknowledgement = next.token;
		if (next.taskId === null || !options.open(next.taskId))
			options.unavailable();
		void acknowledge();
	};
	const read = async () => {
		if (!current()) return;
		const captured = ++revision;
		pending = null;
		if (reading) {
			requested = true;
			return;
		}
		reading = true;
		try {
			const next = await navigation.read();
			if (current() && captured === revision) {
				if (next?.token === consumed) void acknowledge();
				else {
					pending = next;
					flush();
				}
			}
		} catch (error) {
			if (current() && captured === revision) {
				if (retired(error)) acknowledgement = null;
				else options.unavailable();
			}
		} finally {
			reading = false;
			if (requested && current()) {
				requested = false;
				void read();
			}
		}
	};
	const unsubscribe = navigation.subscribe(() => {
		void read();
	});
	void read();
	return {
		flush,
		dispose() {
			alive = false;
			pending = null;
			acknowledgement = null;
			unsubscribe();
		},
	};
}

export function useNativeTaskLinks(
	ready: boolean,
	open: (taskId: string) => boolean,
) {
	const navigation = useNativeAccount()?.taskLinks;
	const { show } = useSnackbar();
	const active = useRef(navigation);
	const callbacks = useRef({ ready, open });
	active.current = navigation;
	callbacks.current = { ready, open };
	const delivery = useRef<ReturnType<typeof createTaskLinkDelivery> | null>(
		null,
	);
	useEffect(() => {
		if (!navigation) return;
		const current = createTaskLinkDelivery(navigation, {
			current: () => active.current === navigation,
			ready: () => callbacks.current.ready,
			open: (taskId) => callbacks.current.open(taskId),
			unavailable: () => show({ message: m.native_link_unavailable() }),
			recovery: (retry) =>
				show({
					message: m.native_link_retry(),
					action: { label: m.action_retry(), run: retry },
				}),
		});
		delivery.current = current;
		return () => {
			current.dispose();
			if (delivery.current === current) delivery.current = null;
		};
	}, [navigation, show]);
	useEffect(() => {
		if (ready) delivery.current?.flush();
	}, [ready]);
}
