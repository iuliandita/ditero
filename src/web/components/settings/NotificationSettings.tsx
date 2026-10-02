import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import type { ChannelKind } from "../../../domain/notification-channel.ts";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { useNotificationChannels } from "../../hooks/useNotificationChannels.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { EscalationFields } from "../task/EscalationFields.tsx";
import { ChannelRow } from "./ChannelRow.tsx";
import { CHANNEL_ORDER, type ChannelHealthRow } from "./channel-form.ts";
import { NativePushSettings } from "./NativePushSettings.tsx";
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
		<div data-testid="escalation-defaults">
			<EscalationFields
				values={{
					repeatEveryMin: defaults?.repeatEveryMin ?? null,
					maxRepeats: defaults?.maxRepeats ?? null,
					fallbackUserId: defaults?.fallbackUserId ?? null,
				}}
				people={people}
				noneLabel={m.escalation_fallback_nobody()}
				maxPlaceholder={String(DEFAULT_MAX_REPEATS)}
				repeatHelp={m.escalation_repeat_help_default()}
				repeatActive={defaults?.repeatEveryMin != null}
				testIds={{
					repeat: "escalation-repeat",
					max: "escalation-max",
					fallback: "escalation-fallback",
				}}
				onChange={set}
			/>
		</div>
	);
}

// Settings > Notifications: Channels, then Quiet hours, then repeating
// reminder defaults, stacked in one scroll (shell doc 1).
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
		<div className="flex flex-col gap-8" data-testid="notification-settings">
			<NativePushSettings />
			<section aria-labelledby="notification-channels-heading">
				<h3
					id="notification-channels-heading"
					className="text-sm font-semibold"
				>
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
						className="mt-0.5 text-sm text-muted-foreground"
						data-testid="no-channels-note"
					>
						{m.notifications_no_channels()}
					</p>
				)}
				<div className="mt-3 flex flex-col divide-y rounded-xl border">
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
			</section>

			<section aria-labelledby="quiet-hours-heading">
				<h3 id="quiet-hours-heading" className="text-sm font-semibold">
					{m.settings_quiet_hours_heading()}
				</h3>
				<p className="mt-0.5 text-sm text-muted-foreground">
					{m.settings_quiet_hours_help()}
				</p>
				<div className="mt-3">
					<QuietHoursEditor />
				</div>
			</section>

			<section aria-labelledby="reminder-defaults-heading">
				<h3 id="reminder-defaults-heading" className="text-sm font-semibold">
					{m.notifications_defaults_heading()}
				</h3>
				<p className="mt-0.5 text-sm text-muted-foreground">
					{m.settings_reminder_defaults_help()}
				</p>
				<div className="mt-3">
					<EscalationDefaults />
				</div>
			</section>
		</div>
	);
}
