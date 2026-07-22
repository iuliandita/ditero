import { useCallback, useEffect, useState } from "react";
import type { ChannelKind } from "../../domain/notification-channel.ts";

// The config column never syncs, so channels come from the server API rather
// than Zero. What the client holds is always the MASKED view: secrets are
// write-only from here on (design 6).
export type ChannelView = {
	kind: ChannelKind;
	enabled: boolean;
	verifiedAt: number | null;
	config: Record<string, unknown>;
};

export type TestResult =
	| { state: "untested" }
	| { state: "verified"; at: number }
	| { state: "failed"; reason: string };

async function post(path: string, body: unknown): Promise<Response> {
	return await fetch(path, {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function useNotificationChannels(): {
	channels: ChannelView[];
	loading: boolean;
	error: string | null;
	save: (input: {
		kind: ChannelKind;
		config: Record<string, unknown>;
		enabled: boolean;
	}) => Promise<boolean>;
	remove: (kind: ChannelKind) => Promise<boolean>;
	test: (input: {
		kind: ChannelKind;
		config: Record<string, unknown>;
		enabled: boolean;
	}) => Promise<TestResult>;
} {
	const [channels, setChannels] = useState<ChannelView[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/notifications/channels", {
				credentials: "include",
			});
			if (!res.ok) {
				setError(`Could not load channels (${res.status}).`);
				return;
			}
			const data = (await res.json()) as { channels: ChannelView[] };
			setChannels(data.channels);
			setError(null);
		} catch {
			setError("Could not load channels.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const save = useCallback<
		(input: {
			kind: ChannelKind;
			config: Record<string, unknown>;
			enabled: boolean;
		}) => Promise<boolean>
	>(
		async (input) => {
			setError(null);
			const res = await post("/api/notifications/channel", input);
			if (!res.ok) {
				setError(
					(await res.text()).trim() || `Could not save (${res.status}).`,
				);
				return false;
			}
			await reload();
			return true;
		},
		[reload],
	);

	const remove = useCallback(
		async (kind: ChannelKind) => {
			setError(null);
			const res = await post("/api/notifications/channel/delete", { kind });
			if (!res.ok) {
				setError(`Could not remove the channel (${res.status}).`);
				return false;
			}
			await reload();
			return true;
		},
		[reload],
	);

	const test = useCallback<
		(input: {
			kind: ChannelKind;
			config: Record<string, unknown>;
			enabled: boolean;
		}) => Promise<TestResult>
	>(
		async (input) => {
			setError(null);
			const res = await post("/api/notifications/channel/test", input);
			if (!res.ok) {
				const reason =
					(await res.text()).trim() || `Test failed (${res.status}).`;
				await reload();
				return { state: "failed", reason };
			}
			const data = (await res.json()) as
				| { ok: true; verifiedAt: number }
				| { ok: false; reason: string };
			await reload();
			return data.ok
				? { state: "verified", at: data.verifiedAt }
				: { state: "failed", reason: data.reason };
		},
		[reload],
	);

	return { channels, loading, error, save, remove, test };
}
