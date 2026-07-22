import { useQuery, useZero } from "@rocicorp/zero/react";
import { Check, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import type { ChannelKind } from "../../../domain/notification-channel.ts";
import { MASKED } from "../../../domain/notification-channel.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import {
	type TestResult,
	useNotificationChannels,
} from "../../hooks/useNotificationChannels.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import {
	maxRepeatsInput,
	REPEAT_EVERY_MIN_MAX,
	REPEATS_MAX,
	repeatEveryMinInput,
} from "../../lib/escalation-input.ts";
import { QuietHoursEditor } from "./QuietHoursEditor.tsx";

// The four channels M3b adds, rendered disabled BELOW the live ntfy row and in
// the design's channel-enum order, so M3b replaces each in place rather than
// reshuffling the list (shell doc 1). ntfy is not here: it has its own row
// component with a config form, not a label.
const PENDING_ROWS: { kind: ChannelKind; label: string }[] = [
	{ kind: "telegram", label: "Telegram" },
	{ kind: "discord", label: "Discord" },
	{ kind: "slack", label: "Slack" },
	{ kind: "email", label: "Email" },
];

// Shell doc 1 asks for a relative timestamp next to "Verified".
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
];

function relativeTime(at: number): string {
	const delta = at - Date.now();
	for (const [unit, ms] of UNITS) {
		if (Math.abs(delta) >= ms)
			return RELATIVE.format(Math.round(delta / ms), unit);
	}
	return RELATIVE.format(0, "minute");
}

type NtfyForm = { serverUrl: string; topic: string; token: string };

const EMPTY_FORM: NtfyForm = { serverUrl: "", topic: "", token: "" };

function NtfyRow({ api }: { api: ReturnType<typeof useNotificationChannels> }) {
	const { channels, loading, error, save, remove, test } = api;
	const stored = channels.find((c) => c.kind === "ntfy") ?? null;

	const [form, setForm] = useState<NtfyForm>(EMPTY_FORM);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<TestResult>({ state: "untested" });
	const [hydrated, setHydrated] = useState(false);

	// Hydrate once from the masked server view: the secret arrives as "***" and
	// is submitted back unchanged unless the user types over it.
	useEffect(() => {
		if (loading || hydrated) return;
		setHydrated(true);
		if (!stored) return;
		const config = stored.config as Partial<Record<keyof NtfyForm, unknown>>;
		setForm({
			serverUrl: typeof config.serverUrl === "string" ? config.serverUrl : "",
			topic: typeof config.topic === "string" ? config.topic : "",
			token: typeof config.token === "string" ? config.token : "",
		});
		setOpen(true);
		if (stored.verifiedAt !== null) {
			setResult({ state: "verified", at: stored.verifiedAt });
		}
	}, [loading, hydrated, stored]);

	function payload() {
		return {
			kind: "ntfy" as const,
			enabled: stored?.enabled ?? true,
			config: {
				serverUrl: form.serverUrl,
				topic: form.topic,
				...(form.token ? { token: form.token } : {}),
			},
		};
	}

	async function onSave() {
		setBusy(true);
		try {
			if (await save(payload())) setResult({ state: "untested" });
		} finally {
			setBusy(false);
		}
	}

	async function onTest() {
		setBusy(true);
		try {
			setResult(await test(payload()));
		} finally {
			setBusy(false);
		}
	}

	// Sends `enabled` alone, never the form: the toggle must not smuggle a
	// half-typed edit into the stored row or reset verified_at (the server
	// preserves the stored config when `config` is omitted).
	async function onToggle() {
		setBusy(true);
		try {
			if (stored) {
				await save({ kind: "ntfy", enabled: !stored.enabled });
			} else {
				setOpen((o) => !o);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-lg border p-3" data-testid="channel-ntfy">
			<div className="flex items-center justify-between gap-3">
				<span className="text-sm font-medium">ntfy</span>
				<Button
					size="sm"
					variant={stored?.enabled ? "default" : "outline"}
					role="switch"
					aria-checked={stored?.enabled ?? false}
					aria-label="ntfy channel enabled"
					data-testid="channel-ntfy-toggle"
					disabled={busy}
					onClick={() => void onToggle()}
				>
					{stored?.enabled ? "On" : "Off"}
				</Button>
			</div>

			{(open || stored) && (
				<div className="mt-3 flex flex-col gap-2">
					<label
						className="flex flex-col gap-1 text-sm"
						htmlFor="ntfy-server-url"
					>
						<span className="text-muted-foreground">Server URL</span>
						<Input
							id="ntfy-server-url"
							value={form.serverUrl}
							data-testid="ntfy-server-url"
							placeholder="https://ntfy.sh"
							onChange={(e) =>
								setForm((f) => ({ ...f, serverUrl: e.target.value }))
							}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm" htmlFor="ntfy-topic">
						<span className="text-muted-foreground">Topic</span>
						<Input
							id="ntfy-topic"
							value={form.topic}
							data-testid="ntfy-topic"
							onChange={(e) =>
								setForm((f) => ({ ...f, topic: e.target.value }))
							}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm" htmlFor="ntfy-token">
						<span className="text-muted-foreground">
							Access token (optional)
						</span>
						<Input
							id="ntfy-token"
							value={form.token}
							data-testid="ntfy-token"
							placeholder={stored ? MASKED : "none"}
							onChange={(e) =>
								setForm((f) => ({ ...f, token: e.target.value }))
							}
						/>
					</label>

					<div className="mt-1 flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							data-testid="ntfy-save"
							disabled={busy}
							onClick={() => void onSave()}
						>
							Save
						</Button>
						<Button
							size="sm"
							variant="outline"
							data-testid="ntfy-test"
							disabled={busy}
							onClick={() => void onTest()}
						>
							Save &amp; test send
						</Button>
						{stored && (
							<Button
								size="sm"
								variant="ghost"
								data-testid="ntfy-remove"
								disabled={busy}
								onClick={() => {
									setForm(EMPTY_FORM);
									setResult({ state: "untested" });
									void remove("ntfy");
								}}
							>
								Remove
							</Button>
						)}
						{/* Async result announced, and never colour-only (shell doc 8). */}
						<span
							role="status"
							aria-live="polite"
							data-testid="ntfy-test-result"
							className="flex items-center gap-1 text-xs"
						>
							{result.state === "verified" && (
								<>
									<Check className="size-3.5 text-emerald-600" />
									Verified {relativeTime(result.at)}
								</>
							)}
							{result.state === "failed" && (
								<>
									<TriangleAlert className="size-3.5 text-destructive" />
									{result.reason}
								</>
							)}
						</span>
					</div>

					{error && (
						<p role="alert" className="text-xs text-destructive">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

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
	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="notification-settings-heading"
			data-testid="notification-settings"
		>
			<h2 id="notification-settings-heading" className="text-sm font-semibold">
				Notifications
			</h2>

			<h3 className="mt-3 text-xs font-medium text-muted-foreground">
				Channels
			</h3>
			{!api.loading && api.channels.length === 0 && (
				<p
					className="mt-1 text-xs text-muted-foreground"
					data-testid="no-channels-note"
				>
					No channel configured yet - reminders will not be delivered outside
					the app.
				</p>
			)}
			<div className="mt-2 flex flex-col gap-2">
				<NtfyRow api={api} />
				{PENDING_ROWS.map((r) => (
					<div
						key={r.kind}
						data-testid={`channel-${r.kind}`}
						aria-disabled="true"
						className="flex items-center justify-between rounded-lg border p-3 text-sm opacity-50"
					>
						<span>{r.label}</span>
						<span className="text-xs">Coming in a future update</span>
					</div>
				))}
			</div>

			<h3 className="mt-6 text-xs font-medium text-muted-foreground">
				Defaults
			</h3>
			<div className="mt-2">
				<QuietHoursEditor />
				<EscalationDefaults />
			</div>
		</section>
	);
}
