import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import type { ChannelKind } from "../../../domain/notification-channel.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { useNotificationChannels } from "../../hooks/useNotificationChannels.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import {
	maxRepeatsInput,
	REPEAT_EVERY_MIN_MAX,
	REPEATS_MAX,
	repeatEveryMinInput,
} from "../../lib/escalation-input.ts";
import { m } from "../../lib/messages.ts";
import { ChannelRow } from "./ChannelRow.tsx";
import { CHANNEL_ORDER, type ChannelHealthRow } from "./channel-form.ts";
import { QuietHoursEditor } from "./QuietHoursEditor.tsx";

function EscalationDefaults() {
	const { pref, setPref } = useUserPref();
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const [memberships] = useQuery(queries.memberships.mine());
	const defaults = pref.escalationDefaults;

	// Co-members across every workspace the caller belongs to -- the same set
	// userPref.set's sharesWorkspace gate accepts.
	const people = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of memberships) {
			if (m.userId !== me && m.user) map.set(m.userId, m.user.name);
		}
		return [...map].map(([id, name]) => ({ id, name }));
	}, [memberships, me]);

	function set(patch: Partial<NonNullable<typeof defaults>>) {
		setPref({
			escalationDefaults: {
				repeatEveryMin: defaults?.repeatEveryMin ?? null,
				maxRepeats: defaults?.maxRepeats ?? null,
				fallbackUserId: defaults?.fallbackUserId ?? null,
				...patch,
			},
		});
	}

	return (
		<div
			className="mt-4 flex flex-wrap gap-3"
			data-testid="escalation-defaults"
		>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">Repeat every (min)</span>
				<input
					type="number"
					min={1}
					max={REPEAT_EVERY_MIN_MAX}
					value={defaults?.repeatEveryMin ?? ""}
					data-testid="escalation-repeat"
					className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
					onChange={(e) =>
						set({ repeatEveryMin: repeatEveryMinInput(e.target.value) })
					}
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">Max repeats</span>
				<input
					type="number"
					min={0}
					max={REPEATS_MAX}
					placeholder={String(DEFAULT_MAX_REPEATS)}
					value={defaults?.maxRepeats ?? ""}
					data-testid="escalation-max"
					className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
					onChange={(e) => set({ maxRepeats: maxRepeatsInput(e.target.value) })}
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">Fallback member</span>
				<select
					value={defaults?.fallbackUserId ?? ""}
					data-testid="escalation-fallback"
					className="h-8 rounded-lg border bg-transparent px-2 text-sm"
					onChange={(e) => set({ fallbackUserId: e.target.value || null })}
				>
					<option value="">Nobody</option>
					{people.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
				</select>
			</label>
		</div>
	);
}

// Settings > Notifications: Channels, then Defaults, stacked in one scroll
// (shell doc 1). Single column on mobile by construction.
export function NotificationSettings() {
	const api = useNotificationChannels();
	// Health (verified/last-error) syncs; config does not. One subscription for
	// all five rows rather than one per row.
	const [rows] = useQuery(queries.notificationChannels.mine());
	const health = useMemo(() => {
		const map = new Map<ChannelKind, ChannelHealthRow>();
		for (const row of rows) {
			map.set(row.kind, {
				verifiedAt: row.verifiedAt ?? null,
				ackVerifiedAt: row.ackVerifiedAt ?? null,
				lastErrorAt: row.lastErrorAt ?? null,
				lastErrorCode: row.lastErrorCode ?? null,
			});
		}
		return map;
	}, [rows]);
	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="notification-settings-heading"
			data-testid="notification-settings"
		>
			<h2 id="notification-settings-heading" className="text-sm font-semibold">
				{m.notifications_heading()}
			</h2>

			<h3 className="mt-3 text-xs font-medium text-muted-foreground">
				{m.notifications_channels_heading()}
			</h3>
			{/* Page-level, not per row: this is the channel LIST failing to load,
			    which is not attributable to any one row. Per-row save failures
			    render inside their own row. */}
			{api.error && (
				<p role="alert" className="mt-1 text-xs text-destructive">
					{api.error}
				</p>
			)}
			{!api.loading && api.channels.length === 0 && (
				<p
					className="mt-1 text-xs text-muted-foreground"
					data-testid="no-channels-note"
				>
					{m.notifications_no_channels()}
				</p>
			)}
			<div className="mt-2 flex flex-col gap-2">
				{CHANNEL_ORDER.map((kind) => (
					<ChannelRow
						key={kind}
						kind={kind}
						api={api}
						capabilities={api.capabilities}
						interactionsUrls={api.interactionsUrls}
						health={health.get(kind) ?? null}
					/>
				))}
			</div>

			<h3 className="mt-6 text-xs font-medium text-muted-foreground">
				{m.notifications_defaults_heading()}
			</h3>
			<div className="mt-2">
				<QuietHoursEditor />
				<EscalationDefaults />
			</div>
		</section>
	);
}
