import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { runMutation } from "@/lib/run-mutation";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import {
	maxRepeatsInput,
	REPEAT_EVERY_MIN_MAX,
	REPEATS_MAX,
	repeatEveryMinInput,
} from "../../lib/escalation-input.ts";

// Per-task reminder policy (shell doc 4). Urgent carries its consequence in its
// own label, not a tooltip: its failure mode is a missed dose.
//
// The reminder-time field appears here only for a non-recurring task; a
// recurring one already edits reminderTime inside RecurrenceEditor (M2), and
// two controls writing the same column would fight each other.
export function ReminderPolicy({
	task,
	workspaceId,
}: {
	task: Task;
	workspaceId: string;
}) {
	const zero = useZero<typeof schema>();
	const me = zero.userID ?? "";
	const { pref } = useUserPref();
	const [memberships] = useQuery(queries.memberships.mine());
	const [error, setError] = useState<string | null>(null);
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
				<label className="flex flex-col gap-1">
					<span className="text-muted-foreground">{m.reminder_time()}</span>
					<input
						type="time"
						value={task.reminderTime ?? ""}
						data-testid="reminder-time"
						aria-label={m.reminder_time()}
						className="h-8 w-fit rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) =>
							update({
								id: task.id,
								reminderTime: e.target.value === "" ? null : e.target.value,
							})
						}
					/>
				</label>
			)}

			<div className="flex items-center justify-between gap-3">
				<span id="urgent-label" className="text-sm">
					{m.reminder_urgent_label()}
				</span>
				<Button
					size="sm"
					variant={task.urgent ? "default" : "outline"}
					role="switch"
					aria-checked={task.urgent ?? false}
					aria-labelledby="urgent-label"
					data-testid="reminder-urgent"
					onClick={() => update({ id: task.id, urgent: !task.urgent })}
				>
					{task.urgent ? m.toggle_on() : m.toggle_off()}
				</Button>
			</div>

			<button
				type="button"
				aria-expanded={open}
				data-testid="reminder-overrides-toggle"
				className="w-fit text-xs text-muted-foreground underline"
				onClick={() => setOpen((o) => !o)}
			>
				{m.reminder_override_defaults()}
			</button>

			{open && (
				<div className="flex flex-wrap gap-3" data-testid="reminder-overrides">
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">
							{m.escalation_repeat_every()}
						</span>
						<input
							type="number"
							min={1}
							max={REPEAT_EVERY_MIN_MAX}
							value={task.repeatEveryMin ?? ""}
							placeholder={String(
								defaults?.repeatEveryMin ?? m.escalation_off(),
							)}
							data-testid="reminder-repeat"
							className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								update({
									id: task.id,
									repeatEveryMin: repeatEveryMinInput(e.target.value),
								})
							}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">
							{m.escalation_max_repeats()}
						</span>
						<input
							type="number"
							min={0}
							max={REPEATS_MAX}
							value={task.maxRepeats ?? ""}
							placeholder={String(defaults?.maxRepeats ?? DEFAULT_MAX_REPEATS)}
							data-testid="reminder-max"
							className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								update({
									id: task.id,
									maxRepeats: maxRepeatsInput(e.target.value),
								})
							}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">
							{m.escalation_fallback_member()}
						</span>
						<select
							value={task.fallbackUserId ?? ""}
							data-testid="reminder-fallback"
							className="h-8 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								update({
									id: task.id,
									fallbackUserId: e.target.value || null,
								})
							}
						>
							<option value="">{m.escalation_inherit_default()}</option>
							{members.map((mem) => (
								<option key={mem.id} value={mem.id}>
									{mem.name}
								</option>
							))}
						</select>
					</label>
				</div>
			)}
		</div>
	);
}
