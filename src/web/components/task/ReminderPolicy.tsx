import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { runMutation } from "@/lib/run-mutation";
import { DEFAULT_MAX_REPEATS } from "../../../domain/escalation-policy.ts";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";

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
					(m) => m.workspaceId === workspaceId && m.userId !== me && m.user,
				)
				.map((m) => ({ id: m.userId, name: m.user?.name ?? m.userId })),
		[memberships, workspaceId, me],
	);

	const defaults = pref.escalationDefaults;

	function update(patch: Parameters<typeof mutators.task.update>[0]) {
		setError(null);
		void runMutation(zero.mutate(mutators.task.update(patch)), setError);
	}

	function toNumber(value: string): number | null {
		const n = Number.parseInt(value, 10);
		return Number.isFinite(n) && n >= 0 ? n : null;
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
					<span className="text-muted-foreground">Reminder time</span>
					<input
						type="time"
						value={task.reminderTime ?? ""}
						data-testid="reminder-time"
						aria-label="Reminder time"
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
					Urgent (ignores quiet hours)
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
					{task.urgent ? "On" : "Off"}
				</Button>
			</div>

			<button
				type="button"
				aria-expanded={open}
				data-testid="reminder-overrides-toggle"
				className="w-fit text-xs text-muted-foreground underline"
				onClick={() => setOpen((o) => !o)}
			>
				Override defaults
			</button>

			{open && (
				<div className="flex flex-wrap gap-3" data-testid="reminder-overrides">
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Repeat every (min)</span>
						<input
							type="number"
							min={1}
							max={10080}
							value={task.repeatEveryMin ?? ""}
							placeholder={String(defaults?.repeatEveryMin ?? "off")}
							data-testid="reminder-repeat"
							className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								update({
									id: task.id,
									repeatEveryMin: toNumber(e.target.value),
								})
							}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Max repeats</span>
						<input
							type="number"
							min={0}
							max={20}
							value={task.maxRepeats ?? ""}
							placeholder={String(defaults?.maxRepeats ?? DEFAULT_MAX_REPEATS)}
							data-testid="reminder-max"
							className="h-8 w-32 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								update({ id: task.id, maxRepeats: toNumber(e.target.value) })
							}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-muted-foreground">Fallback member</span>
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
							<option value="">Inherit default</option>
							{members.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name}
								</option>
							))}
						</select>
					</label>
				</div>
			)}
		</div>
	);
}
