import { useQuery } from "@rocicorp/zero/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import { m } from "../../paraglide/messages.js";
import { queries } from "../../zero/queries.ts";
import {
	type ChannelCapabilities,
	DEFAULT_CAPABILITIES,
	type InteractionsUrls,
} from "../components/settings/channel-form.ts";
import { channelSaveErrorMessage } from "../lib/channel-messages.ts";

// The config column never syncs, so channels come from the server API rather
// than Zero. What the client holds is always the MASKED view: secrets are
// write-only from here on (design 6).
// `config` omitted means "flip enabled only": the server preserves the stored
// config and leaves verified_at alone.
export type ChannelWrite = {
	kind: ChannelKind;
	config?: Record<string, unknown>;
	enabled: boolean;
};

export type ChannelView = {
	kind: ChannelKind;
	enabled: boolean;
	verifiedAt: number | null;
	ackVerifiedAt: number | null;
	config: Record<string, unknown>;
};

export type TestResult =
	| { state: "untested" }
	| { state: "verified"; at: number }
	| { state: "failed"; reason: string };

// Delivery readiness, read straight off the synced notification_channel rows
// (config is omitted at the drizzle-zero layer, enabled/verified_at are not).
// Deliberately not the API hook above: the reminder chip renders per task row
// and must not fire an HTTP request each time.
export function useChannelDeliveryStatus(): { allUnverified: boolean } {
	const [rows] = useQuery(queries.notificationChannels.mine());
	return useMemo(() => {
		const enabled = rows.filter((r) => r.enabled);
		return {
			allUnverified:
				enabled.length > 0 && enabled.every((r) => r.verifiedAt == null),
		};
	}, [rows]);
}

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
	capabilities: ChannelCapabilities;
	interactionsUrls: InteractionsUrls | null;
	loading: boolean;
	error: string | null;
	// save/remove hand the failure BACK rather than only parking it in the shared
	// `error`: five rows read one hook, so a shared error renders a role="alert"
	// inside rows that never failed (shell doc 5 wants per-row regions).
	save: (input: ChannelWrite) => Promise<string | null>;
	remove: (kind: ChannelKind) => Promise<string | null>;
	test: (input: ChannelWrite) => Promise<TestResult>;
} {
	const [channels, setChannels] = useState<ChannelView[]>([]);
	const [capabilities, setCapabilities] =
		useState<ChannelCapabilities>(DEFAULT_CAPABILITIES);
	const [interactionsUrls, setInteractionsUrls] =
		useState<InteractionsUrls | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const res = await fetch("/api/notifications/channels", {
				credentials: "include",
			});
			if (!res.ok) {
				setError(m.channel_load_failed());
				return;
			}
			const data = (await res.json()) as {
				channels: ChannelView[];
				capabilities: ChannelCapabilities;
				interactionsUrls: InteractionsUrls | null;
			};
			setChannels(data.channels);
			setCapabilities(data.capabilities ?? DEFAULT_CAPABILITIES);
			setInteractionsUrls(data.interactionsUrls ?? null);
			setError(null);
		} catch {
			setError(m.channel_load_failed());
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const save = useCallback<(input: ChannelWrite) => Promise<string | null>>(
		async (input) => {
			const res = await post("/api/notifications/channel", input);
			if (!res.ok) {
				return channelSaveErrorMessage((await res.text()).trim());
			}
			await reload();
			return null;
		},
		[reload],
	);

	const remove = useCallback<(kind: ChannelKind) => Promise<string | null>>(
		async (kind) => {
			const res = await post("/api/notifications/channel/delete", { kind });
			if (!res.ok) return m.channel_remove_failed();
			await reload();
			return null;
		},
		[reload],
	);

	const test = useCallback<(input: ChannelWrite) => Promise<TestResult>>(
		async (input) => {
			const res = await post("/api/notifications/channel/test", input);
			if (!res.ok) {
				const reason = channelSaveErrorMessage((await res.text()).trim());
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

	return {
		channels,
		capabilities,
		interactionsUrls,
		loading,
		error,
		save,
		remove,
		test,
	};
}
