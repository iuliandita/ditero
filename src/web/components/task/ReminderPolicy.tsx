import { useQuery, useZero } from "@rocicorp/zero/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { runMutation } from "@/lib/run-mutation";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { EscalationFields } from "./EscalationFields.tsx";
import { TimeField } from "./TimeField.tsx";

// Per-task reminder policy (shell doc 4). Urgent carries its consequence in its
// own label, not a tooltip: its failure mode is a missed dose.
//
// The reminder-time field appears here only for a non-recurring task; a
// recurring one already edits reminderTime inside RecurrenceEditor (M2), and
// two controls writing the same column would fight each other.
export function ReminderPolicy({
	task,
	workspaceId,
	disabled = false,
}: {
	task: Task;
	workspaceId: string;
	disabled?: boolean;
}) {
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const { pref } = useUserPref();
	const [memberships] = useQuery(queries.memberships.mine());
	const [error, setError] = useState<string | null>(null);
	const overridesId = useId();
	const [open, setOpen] = useState(
		task.repeatEveryMin != null ||
			task.maxRepeats != null ||
			task.fallbackUserId != null,
	);

	const members = useMemo(
		() =>
			memberships
				.filter(
					(mem) =>
						mem.workspaceId === workspaceId && mem.userId !== me && mem.user,
				)
				.map((mem) => ({ id: mem.userId, name: mem.user?.name ?? mem.userId })),
		[memberships, workspaceId, me],
	);

	const defaults = pref.escalationDefaults;

	function update(patch: Parameters<typeof mutators.task.update>[0]) {
		if (disabled) return;
		setError(null);
		void runMutation(zero.mutate(mutators.task.update(patch)), setError);
	}

	return (
		<div className="flex flex-col gap-2 text-sm" data-testid="reminder-policy">
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}

			{task.rrule == null && (
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground">{m.reminder_time()}</span>
					<TimeField
						disabled={disabled}
						value={task.reminderTime ?? ""}
						label={m.reminder_time()}
						data-testid="reminder-time"
						onCommit={(next) =>
							update({
								id: task.id,
								reminderTime: next === "" ? null : next,
							})
						}
					/>
				</div>
			)}

			<div className="flex items-center justify-between gap-3">
				<span className="flex flex-col">
					<span id="urgent-label" className="text-sm">
						{m.reminder_urgent_label()}
					</span>
					<span id="urgent-help" className="text-xs text-muted-foreground">
						{m.reminder_urgent_help()}
					</span>
				</span>
				<Button
					disabled={disabled}
					size="sm"
					variant={task.urgent ? "default" : "outline"}
					role="switch"
					aria-checked={task.urgent ?? false}
					aria-labelledby="urgent-label"
					aria-describedby="urgent-help"
					data-testid="reminder-urgent"
					onClick={() => update({ id: task.id, urgent: !task.urgent })}
				>
					{task.urgent ? m.toggle_on() : m.toggle_off()}
				</Button>
			</div>

			<button
				type="button"
				disabled={disabled}
				aria-expanded={open}
				aria-controls={overridesId}
				data-testid="reminder-overrides-toggle"
				className="-mx-1 flex min-h-8 w-fit items-center gap-1 rounded-lg px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed pointer-coarse:min-h-11"
				onClick={() => setOpen((o) => !o)}
			>
				{open ? (
					<ChevronDown className="size-4 shrink-0" aria-hidden="true" />
				) : (
					<ChevronRight
						className="size-4 shrink-0 rtl:rotate-180"
						aria-hidden="true"
					/>
				)}
				{m.reminder_override_defaults()}
			</button>

			{open && (
				<div id={overridesId} className="ps-5" data-testid="reminder-overrides">
					<EscalationFields
						disabled={disabled}
						values={{
							repeatEveryMin: task.repeatEveryMin ?? null,
							maxRepeats: task.maxRepeats ?? null,
							fallbackUserId: task.fallbackUserId ?? null,
						}}
						people={members}
						noneLabel={m.escalation_inherit_default()}
						repeatPlaceholder={
							defaults?.repeatEveryMin != null
								? String(defaults.repeatEveryMin)
								: undefined
						}
						maxPlaceholder={String(defaults?.maxRepeats ?? DEFAULT_MAX_REPEATS)}
						repeatHelp={m.escalation_repeat_help_task()}
						repeatActive={
							(task.repeatEveryMin ?? defaults?.repeatEveryMin ?? null) != null
						}
						testIds={{
							repeat: "reminder-repeat",
							max: "reminder-max",
							fallback: "reminder-fallback",
						}}
						onChange={(patch) => update({ id: task.id, ...patch })}
					/>
				</div>
			)}
		</div>
	);
}
