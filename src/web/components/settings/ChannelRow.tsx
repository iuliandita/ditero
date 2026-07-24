import { Check, ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChannelKind } from "../../../domain/notification-channel.ts";
import { m } from "../../../paraglide/messages.js";
import type {
	TestResult,
	useNotificationChannels,
} from "../../hooks/useNotificationChannels.ts";
import {
	channelErrorMessage,
	channelFieldLabel,
	channelLabel,
	channelModeSummary,
	channelWarningMessage,
} from "../../lib/channel-messages.ts";
import {
	appModeDisabled,
	CHANNEL_MODES,
	type ChannelCapabilities,
	type ChannelHealthRow,
	type ChannelMode,
	channelFields,
	channelHealth,
	formConfig,
	formValues,
	hasModes,
	type InteractionsUrls,
	interactionsUrlFor,
	rowFrozen,
	rowUnavailable,
	rowWarnings,
	type StoredChannel,
	storedMode,
	summaryDetail,
} from "./channel-form.ts";

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
];

const COPIED_RESET_MS = 2_000;

export function relativeTime(at: number): string {
	const delta = at - Date.now();
	for (const [unit, ms] of UNITS) {
		if (Math.abs(delta) >= ms)
			return RELATIVE.format(Math.round(delta / ms), unit);
	}
	return RELATIVE.format(0, "minute");
}

type Api = ReturnType<typeof useNotificationChannels>;

export function ChannelRow({
	kind,
	api,
	capabilities,
	interactionsUrls,
	health,
}: {
	kind: ChannelKind;
	api: Api;
	capabilities: ChannelCapabilities;
	interactionsUrls: InteractionsUrls | null;
	health: ChannelHealthRow | null;
}) {
	const { channels, loading, save, remove, test } = api;
	const stored: StoredChannel | null =
		channels.find((c) => c.kind === kind) ?? null;

	const [open, setOpen] = useState(false);
	const [mode, setMode] = useState<ChannelMode>("webhook");
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<TestResult>({ state: "untested" });
	const [copied, setCopied] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	// Per row, not from the hook: one shared error across five rows renders a
	// role="alert" inside rows that never failed (shell doc 5).
	const [rowError, setRowError] = useState<string | null>(null);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (loading || hydrated) return;
		setHydrated(true);
		const next = storedMode(stored);
		setMode(next);
		setValues(formValues(kind, next, stored));
	}, [loading, hydrated, stored, kind]);

	useEffect(
		() => () => {
			if (copiedTimer.current) clearTimeout(copiedTimer.current);
		},
		[],
	);

	const unavailable = rowUnavailable(kind, capabilities);
	// Unavailable marks the row; it does not freeze a config the user still owns
	// and must be able to inspect or remove (shell doc 6).
	const frozen = rowFrozen(unavailable, stored);
	const warnings = rowWarnings(kind, capabilities, stored);
	const state = channelHealth(stored, health);
	const fields = channelFields(kind, mode);
	const label = channelLabel(kind);
	const rowId = `channel-${kind}`;
	const interactionsUrl = interactionsUrlFor(kind, interactionsUrls);
	// Only a redeemed capability proves the inbound leg; a successful send does
	// not, which is exactly what Discord's silent component drop exploits.
	const acked = state.state === "verified" && state.ackProven;

	function payload() {
		return {
			kind,
			enabled: stored?.enabled ?? true,
			config: formConfig(kind, mode, values),
		};
	}

	async function onSave() {
		setBusy(true);
		try {
			const failure = await save(payload());
			setRowError(failure);
			if (failure === null) setResult({ state: "untested" });
		} finally {
			setBusy(false);
		}
	}

	async function onTest() {
		setBusy(true);
		try {
			setRowError(null);
			setResult(await test(payload()));
		} finally {
			setBusy(false);
		}
	}

	// Sends `enabled` alone, never the form: the toggle must not smuggle a
	// half-typed edit into the stored row or reset verified_at.
	async function onToggle() {
		if (!stored) return;
		setBusy(true);
		try {
			setRowError(await save({ kind, enabled: !stored.enabled }));
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		setBusy(true);
		try {
			setValues(formValues(kind, mode, null));
			setResult({ state: "untested" });
			setRowError(await remove(kind));
		} finally {
			setBusy(false);
		}
	}

	function onMode(next: ChannelMode) {
		setMode(next);
		setValues(formValues(kind, next, stored));
	}

	function onCopy() {
		if (interactionsUrl === null) return;
		void navigator.clipboard?.writeText(interactionsUrl);
		setCopied(true);
		if (copiedTimer.current) clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
	}

	const detail = stored ? summaryDetail(kind, stored.config) : null;
	const summary = stored
		? detail === null
			? null
			: detail.kind === "mode"
				? channelModeSummary(detail.value)
				: detail.value
		: m.channel_summary_unconfigured();

	return (
		<section
			className="rounded-lg border p-3"
			data-testid={rowId}
			aria-labelledby={`${rowId}-name`}
			aria-disabled={unavailable !== null ? "true" : undefined}
		>
			<div className="flex items-center justify-between gap-3">
				{/* No aria-label: it would replace the accessible name and hide the
				    channel, its summary and its status from a screen reader. */}
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					aria-expanded={open}
					aria-controls={`${rowId}-form`}
					data-testid={`${rowId}-disclosure`}
					disabled={frozen}
					onClick={() => setOpen((o) => !o)}
				>
					{open ? (
						<ChevronDown className="size-4 shrink-0" />
					) : (
						<ChevronRight className="size-4 shrink-0" />
					)}
					<span id={`${rowId}-name`} className="text-sm font-medium">
						{label}
					</span>
					{summary !== null && (
						<span className="truncate text-xs text-muted-foreground">
							{summary}
						</span>
					)}
					<StatusText state={state} />
				</button>
				{/* A row with nothing stored has no enabled state to toggle, so it is
				    a plain expand affordance: role="switch" whose aria-checked never
				    changes on activation breaks the switch contract. */}
				{stored ? (
					<Button
						size="sm"
						variant={stored.enabled ? "default" : "outline"}
						role="switch"
						aria-checked={stored.enabled}
						aria-label={m.channel_toggle_label({ channel: label })}
						data-testid={`${rowId}-toggle`}
						disabled={busy}
						onClick={() => void onToggle()}
					>
						{stored.enabled ? m.channel_toggle_on() : m.channel_toggle_off()}
					</Button>
				) : (
					<Button
						size="sm"
						variant="outline"
						aria-expanded={open}
						aria-controls={`${rowId}-form`}
						data-testid={`${rowId}-toggle`}
						disabled={frozen}
						onClick={() => setOpen((o) => !o)}
					>
						{m.channel_action_setup()}
					</Button>
				)}
			</div>

			{/* Reason text is muted, never faded: opacity on real text fails the
			    contrast gate (shell doc 8). */}
			{unavailable !== null && (
				<p
					className="mt-2 text-xs text-muted-foreground"
					data-testid={`${rowId}-unavailable`}
				>
					{channelWarningMessage(unavailable)}
				</p>
			)}
			{warnings.map((warning) => (
				<p
					key={warning}
					className="mt-2 text-xs text-muted-foreground"
					data-testid={`${rowId}-warning-${warning}`}
				>
					{channelWarningMessage(warning)}
				</p>
			))}

			{!frozen && open && (
				<div
					id={`${rowId}-form`}
					className="mt-3 flex flex-col gap-2"
					data-testid={`${rowId}-form`}
				>
					{hasModes(kind) && (
						<fieldset
							className="flex flex-col gap-1"
							aria-describedby={`${rowId}-mode-note`}
							data-testid={`${rowId}-mode`}
						>
							<legend className="text-sm text-muted-foreground">
								{m.channel_mode_legend()}
							</legend>
							<div className="flex gap-2">
								{CHANNEL_MODES.map((option) => {
									const off = option === "app" && appModeDisabled(capabilities);
									return (
										<label
											key={option}
											className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-sm${
												off ? " text-muted-foreground" : ""
											}`}
											htmlFor={`${rowId}-mode-${option}`}
										>
											{/* aria-disabled, not `disabled`: a natively disabled
											    radio leaves the tab order, so the reason its
											    aria-describedby points at is unreachable. */}
											<input
												type="radio"
												id={`${rowId}-mode-${option}`}
												name={`${rowId}-mode`}
												value={option}
												checked={mode === option}
												aria-disabled={off || undefined}
												aria-describedby={
													off ? `${rowId}-mode-app-reason` : undefined
												}
												onChange={() => {
													if (off) return;
													onMode(option);
												}}
											/>
											{option === "app"
												? m.channel_mode_app()
												: m.channel_mode_webhook()}
										</label>
									);
								})}
							</div>
							<p
								id={`${rowId}-mode-note`}
								className="text-xs text-muted-foreground"
								data-testid={`${rowId}-mode-note`}
							>
								{mode === "webhook"
									? m.channel_mode_webhook_note({ channel: label })
									: m.channel_mode_app_note({ channel: label })}
							</p>
							{appModeDisabled(capabilities) && (
								<p
									id={`${rowId}-mode-app-reason`}
									className="text-xs text-muted-foreground"
									data-testid={`${rowId}-mode-app-reason`}
								>
									{m.channel_mode_app_unavailable()}
								</p>
							)}
						</fieldset>
					)}

					{mode === "app" && interactionsUrl !== null && (
						<div className="flex flex-col gap-1">
							<p className="text-xs text-muted-foreground">
								{m.channel_app_setup_hint()}
							</p>
							<label
								className="flex flex-col gap-1 text-sm"
								htmlFor={`${rowId}-interactions-url`}
							>
								<span className="text-muted-foreground">
									{m.channel_interactions_url_label()}
								</span>
								<span className="flex gap-2">
									<Input
										id={`${rowId}-interactions-url`}
										readOnly
										value={interactionsUrl}
										data-testid={`${rowId}-interactions-url`}
									/>
									<Button
										size="sm"
										variant="outline"
										data-testid={`${rowId}-copy`}
										onClick={onCopy}
									>
										{copied ? m.channel_copied() : m.channel_copy()}
									</Button>
								</span>
							</label>
						</div>
					)}

					{fields.map((field) => (
						<label
							key={field.key}
							className="flex flex-col gap-1 text-sm"
							htmlFor={`${rowId}-${field.key}`}
						>
							<span className="text-muted-foreground">
								{channelFieldLabel(field.key)}
							</span>
							{/* Masked fields are plain text, not type=password: the stored
							    value never comes back in cleartext, so dot-masking hides
							    only what the user just pasted. No placeholder either -- a
							    stored secret already arrives as the literal MASKED in the
							    value, so a placeholder could only ever appear on a field
							    that has nothing stored (shell doc 2). */}
							<Input
								id={`${rowId}-${field.key}`}
								type={field.secret ? "text" : field.type}
								value={values[field.key] ?? ""}
								autoCapitalize="off"
								autoCorrect="off"
								spellCheck={false}
								data-testid={`${rowId}-${field.key}`}
								onChange={(e) =>
									setValues((v) => ({ ...v, [field.key]: e.target.value }))
								}
							/>
						</label>
					))}

					<div className="mt-1 flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							data-testid={`${rowId}-save`}
							disabled={busy}
							onClick={() => void onSave()}
						>
							{m.channel_action_save()}
						</Button>
						<Button
							size="sm"
							variant="outline"
							data-testid={`${rowId}-test`}
							disabled={busy}
							onClick={() => void onTest()}
						>
							{m.channel_action_test()}
						</Button>
						{stored && (
							<Button
								size="sm"
								variant="ghost"
								data-testid={`${rowId}-remove`}
								disabled={busy}
								onClick={() => void onRemove()}
							>
								{m.channel_action_remove()}
							</Button>
						)}
						{/* One live region per row: five results announced from one
						    shared region would read out the wrong channel's outcome. */}
						<span
							role="status"
							aria-live="polite"
							data-testid={`${rowId}-test-result`}
							className="flex items-center gap-1 text-xs"
						>
							{copied && m.channel_copied_announcement()}
							{result.state === "verified" && (
								<>
									<Check className="size-3.5 text-emerald-600" />
									{acked
										? m.channel_status_test_acked()
										: m.channel_status_test_sent()}
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

					{rowError && (
						<p
							role="alert"
							className="text-xs text-destructive"
							data-testid={`${rowId}-error`}
						>
							{rowError}
						</p>
					)}
				</div>
			)}
		</section>
	);
}

function StatusText({ state }: { state: ReturnType<typeof channelHealth> }) {
	if (state.state === "failing") {
		return (
			<span className="flex items-center gap-1 text-xs text-destructive">
				<TriangleAlert className="size-3.5" />
				{m.channel_status_rejected()} {channelErrorMessage(state.code)}
			</span>
		);
	}
	if (state.state === "verified") {
		const when = relativeTime(state.at);
		// "Verified" is a claim about the ack path, so it is only made once an ack
		// actually came back. A send the provider accepted says only "Sent".
		return state.ackProven ? (
			<span className="flex items-center gap-1 text-xs text-muted-foreground">
				<Check className="size-3.5 text-emerald-600" />
				{m.channel_status_verified({ when })}
			</span>
		) : (
			<span className="text-xs text-muted-foreground">
				{m.channel_status_sent_unacked({ when })}
			</span>
		);
	}
	if (state.state === "untested") {
		return (
			<span className="text-xs text-muted-foreground">
				{m.channel_status_untested()}
			</span>
		);
	}
	return null;
}
