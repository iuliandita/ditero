import { useZero } from "@rocicorp/zero/react";
import { Check, Plus, SkipForward, Timer, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { runMutation } from "@/lib/run-mutation";
import {
	dueToInputs,
	inputsToDue,
	priorityLabelShort,
	priorityMeta,
} from "@/lib/task-display";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { keyBetween } from "../../../domain/sort-key.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type { Label, List, schema, Task } from "../../../zero/schema.gen.ts";
import { formatFocusedDuration } from "../../focus/timer-core.ts";
import { useFocusTimer } from "../../focus/useFocusTimer.tsx";
import { useFocusSessions } from "../../hooks/useFocusSessions.ts";
import { AssigneePicker } from "../people/AssigneePicker.tsx";
import { CommentThread } from "../people/CommentThread.tsx";
import { RecurrenceEditor } from "../task/RecurrenceEditor.tsx";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { ReminderPolicy } from "../task/ReminderPolicy.tsx";

const PRIORITY_OPTIONS = [0, 1, 2, 3];

// Sort key placing a moved task after the last top-level task in the target list.
function tailKey(tasks: Task[]): string {
	const last = tasks.reduce<string | null>(
		(max, t) => (max == null || t.sortKey > max ? t.sortKey : max),
		null,
	);
	return keyBetween(last, null);
}

export function TaskDetail({
	task,
	open,
	onOpenChange,
	list,
	allLists,
	allTasks,
	allLabels,
	taskLabelIds,
}: {
	task: Task | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	list: List;
	allLists: List[];
	allTasks: Task[];
	allLabels: Label[];
	taskLabelIds: string[];
}) {
	const isDesktop = useIsDesktop();
	const zero = useZero<typeof schema>();
	const focus = useFocusTimer();
	const [error, setError] = useState<string | null>(null);
	const [newSubtask, setNewSubtask] = useState("");
	const [newLabel, setNewLabel] = useState("");

	// Total time-on-task = sum of this task's completed `work` focus intervals.
	const { sessions: focusSessions } = useFocusSessions(task?.id);
	const focusedSec = useMemo(
		() =>
			focusSessions.reduce(
				(sum, s) => (s.kind === "work" ? sum + s.durationSec : sum),
				0,
			),
		[focusSessions],
	);

	const kind = (list.kind ?? "tasks") as List["kind"];
	const subtasks = useMemo(
		() => (task ? allTasks.filter((t) => t.parentId === task.id) : []),
		[allTasks, task],
	);
	const moveTargets = useMemo(
		() =>
			allLists.filter(
				(l) => l.workspaceId === list.workspaceId && l.id !== list.id,
			),
		[allLists, list],
	);
	const selected = new Set(taskLabelIds);

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}

	if (!task) return null;
	// Alias the narrowed task so the handler closures below keep the non-null type.
	const t = task;
	const isSubtask = t.parentId != null;
	const due = dueToInputs(t.dueAt);

	function update(patch: Parameters<typeof mutators.task.update>[0]) {
		void run(zero.mutate(mutators.task.update(patch)));
	}

	function setDue(date: string, time: string) {
		const { dueAt, dueAllDay } = inputsToDue(date, time);
		update({ id: t.id, dueAt, dueAllDay });
	}

	function toggleLabel(labelId: string) {
		const next = new Set(selected);
		if (next.has(labelId)) next.delete(labelId);
		else next.add(labelId);
		void run(
			zero.mutate(
				mutators.taskLabel.set({ taskId: t.id, labelIds: [...next] }),
			),
		);
	}

	async function createLabel() {
		const name = newLabel.trim();
		if (!name) return;
		const id = crypto.randomUUID();
		// Two sequential mutators (create the label, then attach it): not one atomic
		// tx. Both are optimistic and local, so a partial state is momentary; the
		// worst case is an orphan label if the second write fails, which the label
		// manager can clean up. Fold into a single mutator if this proves fragile.
		setError(null);
		try {
			await zero.mutate(
				mutators.label.create({ id, workspaceId: list.workspaceId, name }),
			).client;
			await zero.mutate(
				mutators.taskLabel.set({
					taskId: t.id,
					labelIds: [...selected, id],
				}),
			).client;
			setNewLabel("");
		} catch (e) {
			setError(e instanceof Error ? e.message : m.task_create_label_failed());
		}
	}

	function addSubtask() {
		const title = newSubtask.trim();
		if (!title) return;
		void run(
			zero.mutate(
				mutators.task.create({
					id: crypto.randomUUID(),
					listId: t.listId,
					title,
					sortKey: tailKey(subtasks),
					parentId: t.id,
				}),
			),
		);
		setNewSubtask("");
	}

	const currentLabels = allLabels.filter((l) => selected.has(l.id));

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isDesktop ? "right" : "bottom"}
				className={cn("gap-0 overflow-y-auto", !isDesktop && "max-h-[90dvh]")}
			>
				<SheetHeader>
					<SheetTitle className="sr-only">{m.task_detail_title()}</SheetTitle>
					<Input
						defaultValue={task.title}
						key={task.id}
						aria-label={m.task_detail_title_field()}
						className="h-9 border-transparent px-0 text-base font-medium focus-visible:border-input focus-visible:px-2.5"
						onBlur={(e) => {
							const v = e.target.value.trim();
							if (v && v !== task.title) update({ id: task.id, title: v });
						}}
					/>
				</SheetHeader>

				<div className="flex flex-col gap-4 p-4 pt-2">
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}

					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">
							{m.task_field_notes()}
						</span>
						<textarea
							key={`notes-${task.id}`}
							defaultValue={task.notes ?? ""}
							rows={3}
							className="w-full rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:border-ring"
							onBlur={(e) => {
								const v = e.target.value;
								if (v !== (task.notes ?? ""))
									update({ id: task.id, notes: v || null });
							}}
						/>
					</label>

					<div className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{m.task_field_due()}</span>
						<div className="flex items-center gap-2">
							<input
								type="date"
								value={due.date}
								aria-label={m.task_due_date_aria()}
								className="h-8 rounded-lg border bg-transparent px-2 text-sm"
								onChange={(e) => setDue(e.target.value, due.time)}
							/>
							<input
								type="time"
								value={due.time}
								aria-label={m.task_due_time_aria()}
								disabled={!due.date}
								className="h-8 rounded-lg border bg-transparent px-2 text-sm disabled:opacity-50"
								onChange={(e) => setDue(due.date, e.target.value)}
							/>
							{task.dueAt != null && (
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={m.task_due_clear()}
									onClick={() => update({ id: task.id, dueAt: null })}
								>
									<X />
								</Button>
							)}
							<ReminderChip task={t} />
						</div>
					</div>

					<div className="flex items-center justify-between gap-2 text-sm">
						<span
							className="text-muted-foreground"
							data-testid="task-time-on-task"
						>
							{focusedSec > 0
								? formatFocusedDuration(focusedSec)
								: m.task_no_focus_time()}
						</span>
						<Button
							variant="outline"
							size="sm"
							data-testid="task-focus-start"
							onClick={() => focus.startForTask(t.id, t.title)}
						>
							<Timer /> {m.task_start_focus()}
						</Button>
					</div>

					{!isSubtask && <RecurrenceEditor key={t.id} task={t} />}

					{!isSubtask && (
						<ReminderPolicy
							key={`reminder-${t.id}`}
							task={t}
							workspaceId={list.workspaceId}
						/>
					)}

					{!isSubtask && t.rrule != null && kind !== "habits" && (
						<Button
							variant="outline"
							size="sm"
							className="self-start"
							data-testid="recurrence-skip"
							aria-label={m.task_skip_occurrence()}
							onClick={() =>
								void run(
									zero.mutate(mutators.task.skipOccurrence({ id: t.id })),
								)
							}
						>
							<SkipForward /> {m.task_skip_occurrence()}
						</Button>
					)}

					{kind !== "checklist" && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.task_field_priority()}
							</span>
							<div className="flex gap-1.5">
								{PRIORITY_OPTIONS.map((level) => {
									const meta = priorityMeta(level);
									const active = (task.priority ?? 0) === level;
									return (
										<button
											key={level}
											type="button"
											aria-pressed={active}
											onClick={() => update({ id: task.id, priority: level })}
											className={cn(
												"flex-1 rounded-lg border px-2 py-1 text-sm",
												active
													? "border-ring bg-muted font-medium"
													: "text-muted-foreground",
												active && meta ? meta.color : "",
											)}
										>
											{priorityLabelShort(level)}
										</button>
									);
								})}
							</div>
						</div>
					)}

					{kind !== "checklist" && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.task_field_labels()}
							</span>
							<div className="flex flex-wrap items-center gap-1.5">
								{currentLabels.map((l) => (
									<Badge key={l.id} variant="secondary">
										{l.name}
									</Badge>
								))}
								<Popover>
									<PopoverTrigger asChild>
										<Button variant="outline" size="sm">
											<Plus /> {m.task_field_labels()}
										</Button>
									</PopoverTrigger>
									<PopoverContent align="start" className="w-64">
										<div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
											{allLabels.map((l) => (
												<button
													key={l.id}
													type="button"
													aria-pressed={selected.has(l.id)}
													onClick={() => toggleLabel(l.id)}
													className="flex items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm hover:bg-muted"
												>
													<span className="flex size-4 items-center justify-center">
														{selected.has(l.id) && (
															<Check className="size-3.5" />
														)}
													</span>
													{l.name}
												</button>
											))}
											{allLabels.length === 0 && (
												<span className="px-1.5 py-1 text-xs text-muted-foreground">
													{m.task_no_labels()}
												</span>
											)}
										</div>
										<div className="flex items-center gap-1.5 border-t pt-2">
											<Input
												value={newLabel}
												placeholder={m.task_new_label_placeholder()}
												onChange={(e) => setNewLabel(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") void createLabel();
												}}
											/>
											<Button
												size="sm"
												onClick={() => void createLabel()}
												disabled={!newLabel.trim()}
											>
												{m.action_add()}
											</Button>
										</div>
									</PopoverContent>
								</Popover>
							</div>
						</div>
					)}

					<AssigneePicker task={t} workspaceId={list.workspaceId} />

					{!isSubtask && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.task_field_subtasks()}
							</span>
							<ul className="flex flex-col">
								{subtasks.map((s) => (
									<li key={s.id} className="flex items-center gap-2 py-1">
										<Checkbox
											aria-label={s.title}
											checked={s.done ?? false}
											onCheckedChange={() => {
												if (s.done) update({ id: s.id, done: false });
												else
													void run(
														zero.mutate(mutators.task.complete({ id: s.id })),
													);
											}}
										/>
										<span
											className={cn(
												"min-w-0 flex-1 truncate",
												s.done && "text-muted-foreground line-through",
											)}
										>
											{s.title}
										</span>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={m.task_delete_named({ title: s.title })}
											onClick={() =>
												void run(
													zero.mutate(mutators.task.delete({ id: s.id })),
												)
											}
										>
											<Trash2 />
										</Button>
									</li>
								))}
							</ul>
							<div className="flex items-center gap-1.5">
								<Input
									value={newSubtask}
									placeholder={m.task_add_subtask_placeholder()}
									onChange={(e) => setNewSubtask(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") addSubtask();
									}}
								/>
								<Button
									size="sm"
									onClick={addSubtask}
									disabled={!newSubtask.trim()}
								>
									{m.action_add()}
								</Button>
							</div>
						</div>
					)}

					{!isSubtask && moveTargets.length > 0 && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.task_move_to_list()}
							</span>
							<Select
								value={list.id}
								onValueChange={(target) => {
									const targetTasks = allTasks.filter(
										(t) => t.listId === target && t.parentId == null,
									);
									void run(
										zero.mutate(
											mutators.task.move({
												id: task.id,
												listId: target,
												sortKey: tailKey(targetTasks),
											}),
										),
									);
									onOpenChange(false);
								}}
							>
								<SelectTrigger
									aria-label={m.task_move_to_list()}
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={list.id}>{list.title}</SelectItem>
									{moveTargets.map((l) => (
										<SelectItem key={l.id} value={l.id}>
											{l.title}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					<div className="border-t pt-3">
						<CommentThread task={t} workspaceId={list.workspaceId} />
					</div>

					<Button
						variant="destructive"
						className="self-start"
						onClick={() => {
							void run(zero.mutate(mutators.task.delete({ id: task.id })));
							onOpenChange(false);
						}}
					>
						<Trash2 /> {m.task_delete()}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}
