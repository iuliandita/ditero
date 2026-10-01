import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	Check,
	ChevronRight,
	Flag,
	Plus,
	SkipForward,
	Timer,
	Trash2,
	X,
} from "lucide-react";
import {
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { checkShapeFor, checkToneFor } from "@/lib/check-shape";
import { recordRecent } from "@/lib/recents";
import {
	type MutationFailure,
	mutationFailureMessage,
	mutationResultFailure,
	runMutation,
} from "@/lib/run-mutation";
import { inputsToDue, priorityLabel, priorityMeta } from "@/lib/task-display";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { localDay } from "../../../domain/local-day.ts";
import { randomId } from "../../../domain/random-id.ts";
import { keyBetween } from "../../../domain/sort-key.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { Label, List, schema, Task } from "../../../zero/schema.gen.ts";
import { formatFocusedDuration } from "../../focus/timer-core.ts";
import { useFocusTimer } from "../../focus/useFocusTimer.tsx";
import { useFocusSessions } from "../../hooks/useFocusSessions.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";
import {
	taskImportRecoveryKey,
	useTaskImportActivation,
	useTaskImportActivationMap,
} from "../../hooks/useTaskImportActivation.ts";
import { useTaskToggle } from "../../hooks/useTaskToggle.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { formatTimeValue } from "../../lib/date-picker.ts";
import { formatList } from "../../lib/intl-format.ts";
import { onMutationFailure } from "../../lib/mutation-outcome.ts";
import { markTaskPanelOpen } from "../../lib/use-wide-content.ts";
import { AttachmentList } from "../attachments/AttachmentList.tsx";
import { AssigneePicker } from "../people/AssigneePicker.tsx";
import { CommentThread } from "../people/CommentThread.tsx";
import { DuePicker } from "../task/DuePicker.tsx";
import { RecurrenceEditor } from "../task/RecurrenceEditor.tsx";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { ReminderPolicy } from "../task/ReminderPolicy.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import type { RowAction } from "../ui/row-action.ts";
import { RowActions } from "../ui/row-actions.tsx";
import { useSnackbar } from "../ui/snackbar.tsx";
import { ImportActivationRecovery } from "./ImportActivationRecovery.tsx";

// P1 first, matching quick-add's p1-p4 reading order.
const PRIORITY_ORDER = [3, 2, 1, 0];

// Docked beside the list from lg. At 1024px with the sidebar expanded the list
// keeps ~310px, the phone column the rows are already built for; at 1280px it
// keeps ~510px. Below lg the list would drop under 250px, so tablets and phones
// get the bottom sheet. The widths here (w-96, xl:w-110) are the ones AppShell
// reserves while [data-task-panel] is mounted.
const DOCKED_QUERY = "(min-width: 1024px)";

const MORE_KEY = "ditero.taskDetail.moreOpen";

// Per-session convenience only; storage can be unavailable (private mode) and
// the disclosure then simply starts closed.
function readMoreOpen(): boolean {
	try {
		return sessionStorage.getItem(MORE_KEY) === "1";
	} catch {
		return false;
	}
}

function writeMoreOpen(open: boolean) {
	try {
		sessionStorage.setItem(MORE_KEY, open ? "1" : "0");
	} catch {}
}

// Where focus goes back to on close. Rows re-render (completing sinks a row
// into its group, a sync can remount it), so the element is backed by the
// task id every row's open button carries, and by the next row's id for when
// the task itself left the list.
type ReturnTarget = {
	el: HTMLElement;
	taskId: string | null;
	nextTaskId: string | null;
};

function findRow(taskId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		`[data-task-id="${CSS.escape(taskId)}"]`,
	);
}

function captureReturn(el: HTMLElement): ReturnTarget {
	const taskId = el.dataset.taskId ?? null;
	if (taskId == null) return { el, taskId, nextTaskId: null };
	const rows = [...document.querySelectorAll<HTMLElement>("[data-task-id]")];
	const next = rows
		.slice(rows.indexOf(el) + 1)
		.find((row) => row.dataset.taskId !== taskId);
	return { el, taskId, nextTaskId: next?.dataset.taskId ?? null };
}

function resolveReturn(
	target: ReturnTarget,
	leaving: boolean,
): HTMLElement | null {
	if (!leaving) {
		if (target.el.isConnected) return target.el;
		const row = target.taskId ? findRow(target.taskId) : null;
		if (row) return row;
	}
	if (target.taskId == null) return null;
	const next = target.nextTaskId ? findRow(target.nextTaskId) : null;
	if (next) return next;
	const add = document.querySelector<HTMLElement>('[data-testid="new-task"]');
	return add?.getClientRects().length ? add : null;
}

function isTextField(el: Element | null): el is HTMLElement {
	return (
		el instanceof HTMLElement &&
		(el.isContentEditable || ["INPUT", "TEXTAREA"].includes(el.tagName))
	);
}

// Sort key placing a moved task after the last top-level task in the target list.
function tailKey(tasks: Task[]): string {
	const last = tasks.reduce<string | null>(
		(max, t) => (max == null || t.sortKey > max ? t.sortKey : max),
		null,
	);
	return keyBetween(last, null);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5 text-sm">
			<span className="text-muted-foreground">{label}</span>
			{children}
		</div>
	);
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
	const docked = useMediaQuery(DOCKED_QUERY);
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const sourceWorkspace = workspaces.find((w) => w.id === list.workspaceId);
	const focus = useFocusTimer();
	const confirm = useConfirm();
	const snackbar = useSnackbar();
	const [error, setError] = useState<string | null>(null);
	const [newSubtask, setNewSubtask] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [moreOpen, setMoreOpen] = useState(readMoreOpen);
	const moreId = useId();
	const panelRef = useRef<HTMLDivElement>(null);
	const titleRef = useRef<HTMLInputElement>(null);
	// An unsaved title edit, kept outside the input: crossing the lg breakpoint
	// swaps panel and sheet, which remounts the input without a blur.
	const titleDraft = useRef<{ id: string; value: string } | null>(null);
	const returnFocus = useRef<ReturnTarget | null>(null);
	const activation = useTaskImportActivation(task?.id);
	const activationMap = useTaskImportActivationMap();

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
	// A habit is never "done"; its box is today's occurrence, logged exactly as
	// the habit card's Done does (task.complete refuses habits by design).
	const { pref } = useUserPref();
	const { logs: habitLogs } = useHabitLogs(task?.id ?? "");
	const today = localDay(new Date(), pref.timezone);
	const habitDoneToday = habitLogs.some(
		(l) => l.date === today && l.status === "done",
	);
	const subtasks = useMemo(
		() => (task ? allTasks.filter((t) => t.parentId === task.id) : []),
		[allTasks, task],
	);
	const canMove =
		activation.canWrite &&
		subtasks.every((subtask) => activationMap.canWriteTask(subtask.id));
	const moveTargets = useMemo(
		() =>
			allLists.filter(
				(l) => l.workspaceId === list.workspaceId && l.id !== list.id,
			),
		[allLists, list],
	);
	const selected = new Set(taskLabelIds);

	// `leaving`: the task is gone from this list (deleted, moved), so focus goes
	// to the row after it instead.
	function close({ leaving = false }: { leaving?: boolean } = {}) {
		const active = document.activeElement;
		const inPanel =
			active instanceof HTMLElement &&
			panelRef.current?.contains(active) === true;
		// Title, notes and time fields save on blur; flush them before unmount.
		if (inPanel) (active as HTMLElement).blur();
		onOpenChange(false);
		const target = returnFocus.current;
		returnFocus.current = null;
		// Only reclaim focus the panel held; a user already back in the list
		// keeps their place.
		const reclaim =
			leaving || inPanel || active == null || active === document.body;
		if (!docked || !reclaim || !target) return;
		// Next frame: the panel has unmounted by then, and a closing Radix Select
		// or menu has already put focus back on its own (now gone) trigger.
		requestAnimationFrame(() =>
			resolveReturn(target, leaving)?.focus({ preventScroll: true }),
		);
	}
	const closeRef = useRef(() => close());
	closeRef.current = () => close();

	// Escape in a field leaves the field first (blur commits title, notes and
	// time fields; a subtask draft stays put), landing on the panel itself; only
	// the next Escape closes. Returns whether this Escape was consumed.
	function leaveField(): boolean {
		if (revertTitle()) return true;
		const active = document.activeElement;
		if (!isTextField(active) || !panelRef.current?.contains(active))
			return false;
		active.blur();
		panelRef.current.focus({ preventScroll: true });
		return true;
	}

	// Escape with a dirty title cancels the edit instead of closing.
	function revertTitle(): boolean {
		const el = titleRef.current;
		if (!el || !task || document.activeElement !== el) return false;
		if (el.value === task.title) return false;
		el.value = task.title;
		titleDraft.current = null;
		return true;
	}

	// Where focus lands when the surface (re)mounts: back into an unsaved title
	// edit, caret at the end, or else the surface itself.
	function focusSurface() {
		const title = titleRef.current;
		if (title && titleDraft.current?.id === task?.id) {
			title.focus({ preventScroll: true });
			title.setSelectionRange(title.value.length, title.value.length);
			return;
		}
		panelRef.current?.focus({ preventScroll: true });
	}

	const shownId = open && task ? task.id : null;

	useEffect(() => {
		if (shownId) recordRecent(zero.userID, { kind: "task", id: shownId });
	}, [shownId, zero.userID]);

	// Docked is non-modal, so focus is managed by hand: into the panel on open
	// and on every swap, back to the row that opened it on close.
	useEffect(() => {
		const panel = panelRef.current;
		if (!docked || shownId == null || !panel) return;
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			active !== document.body &&
			!panel.contains(active)
		)
			returnFocus.current = captureReturn(active);
		const title = titleRef.current;
		if (title && titleDraft.current?.id === shownId) {
			title.focus({ preventScroll: true });
			title.setSelectionRange(title.value.length, title.value.length);
		} else panel.focus({ preventScroll: true });
	}, [docked, shownId]);

	// Layouts beside the docked panel check their width only while it is open.
	const docks = docked && shownId != null;
	useEffect(() => (docks ? markTaskPanelOpen() : undefined), [docks]);

	// Focus may be back in the list (triaging) or on <body>; Escape still closes.
	// Text fields outside the panel keep Escape for themselves, and anything
	// that already handled it (a menu, a popover) marked it defaultPrevented.
	useEffect(() => {
		if (!docked || shownId == null) return;
		function onKey(e: KeyboardEvent) {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const active = document.activeElement;
			if (active && panelRef.current?.contains(active)) return;
			if (
				active instanceof HTMLElement &&
				(active.isContentEditable ||
					["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))
			)
				return;
			closeRef.current();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [docked, shownId]);

	function toggleMore() {
		const next = !moreOpen;
		setMoreOpen(next);
		writeMoreOpen(next);
	}

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}
	// The rows' own toggle, so the completion snackbar (and its no-Undo rule for
	// recurring tasks) is identical from the panel.
	const toggleTask = useTaskToggle(run);

	if (!task || !open) return null;
	// Alias the narrowed task so the handler closures below keep the non-null type.
	const t = task;
	const isSubtask = t.parentId != null;

	function update(patch: Parameters<typeof mutators.task.update>[0]) {
		if (!activationMap.canWriteTask(patch.id)) return;
		void run(zero.mutate(mutators.task.update(patch)));
	}

	const isHabit = kind === "habits";
	const checked = isHabit ? habitDoneToday : (t.done ?? false);

	// Same path as the list rows (or the habit card), so recurrence advance,
	// Karma and the completion snackbar stay identical.
	function toggleDone() {
		if (!activation.canWrite) return;
		if (!isHabit) {
			toggleTask(t);
			return;
		}
		void run(
			zero.mutate(
				habitDoneToday
					? mutators.habit.unlog({ habitId: t.id, date: today })
					: mutators.habit.log({ habitId: t.id, date: today, status: "done" }),
			),
		);
	}

	function saveTitle(el: HTMLInputElement) {
		titleDraft.current = null;
		const v = el.value.trim();
		if (!v) {
			el.value = t.title;
			return;
		}
		if (v !== t.title) update({ id: t.id, title: v });
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
		const id = randomId();
		// Two sequential mutators (create the label, then attach it): not one atomic
		// tx. Both are optimistic and local, so a partial state is momentary; the
		// worst case is an orphan label if the second write fails, which the label
		// manager can clean up. Fold into a single mutator if this proves fragile.
		setError(null);
		// Zero resolves a refused write with an error result; it never throws.
		const failed = (failure: MutationFailure) =>
			setError(mutationFailureMessage(failure, m.task_create_label_failed));
		const created = mutationResultFailure(
			await zero.mutate(
				mutators.label.create({ id, workspaceId: list.workspaceId, name }),
			).client,
		);
		if (created !== null) return failed(created);
		const attached = mutationResultFailure(
			await zero.mutate(
				mutators.taskLabel.set({
					taskId: t.id,
					labelIds: [...selected, id],
				}),
			).client,
		);
		if (attached !== null) return failed(attached);
		setNewLabel("");
	}

	function addSubtask() {
		if (!activation.canWrite) return;
		const title = newSubtask.trim();
		if (!title) return;
		void run(
			zero.mutate(
				mutators.task.create({
					id: randomId(),
					listId: t.listId,
					title,
					sortKey: tailKey(subtasks),
					parentId: t.id,
				}),
			),
		);
		setNewSubtask("");
	}

	async function removeTask() {
		// task.delete cascades children, so the confirm states them.
		const count = allTasks.filter((s) => s.parentId === t.id).length;
		const ok = await confirm({
			title: m.task_delete_title(),
			body:
				count > 0
					? m.task_delete_confirm_subtasks({ title: t.title, count })
					: m.task_delete_confirm({ title: t.title }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void run(zero.mutate(mutators.task.delete({ id: t.id })));
		close({ leaving: true });
	}

	async function removeSubtask(subtask: Task, trigger: HTMLButtonElement) {
		const ok = await confirm({
			title: m.task_delete_title(),
			body: m.task_delete_confirm({ title: subtask.title }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) {
			requestAnimationFrame(() => {
				if (trigger.isConnected) trigger.focus();
			});
			return;
		}
		void run(zero.mutate(mutators.task.delete({ id: subtask.id })));
	}

	// Not gated on import activation: a paused task must stay deletable.
	const headerActions: RowAction[] = [
		{
			id: "delete",
			label: m.task_delete(),
			icon: Trash2,
			destructive: true,
			onSelect: () => void removeTask(),
		},
	];

	const currentLabels = allLabels.filter((l) => selected.has(l.id));

	const moreSummary = formatList(
		[
			t.rrule != null ? m.task_more_repeats() : null,
			t.reminderTime
				? m.task_more_reminder({
						time: formatTimeValue(t.reminderTime, getLocale()),
					})
				: null,
			t.urgent ? m.task_more_urgent() : null,
		].filter((part) => part != null),
		"unit",
	);

	const header = (
		<div className="flex items-center gap-3 px-4 pt-4 pb-3">
			<Checkbox
				disabled={!activation.canWrite}
				checked={checked}
				aria-label={m.task_detail_done_aria()}
				data-testid="task-detail-done"
				onCheckedChange={toggleDone}
				shape={checkShapeFor(kind ?? "tasks")}
				priority={checkToneFor(kind ?? "tasks", t.priority)}
			/>
			<Input
				ref={titleRef}
				disabled={!activation.canWrite}
				defaultValue={
					titleDraft.current?.id === t.id ? titleDraft.current.value : t.title
				}
				key={t.id}
				onChange={(e) => {
					titleDraft.current = { id: t.id, value: e.currentTarget.value };
				}}
				aria-label={m.task_detail_title_field()}
				data-testid="task-detail-title"
				className={cn(
					"h-9 min-w-0 flex-1 border-transparent px-1.5 text-base font-medium focus-visible:border-input",
					checked && "text-muted-foreground line-through",
				)}
				onBlur={(e) => saveTitle(e.currentTarget)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						saveTitle(e.currentTarget);
					} else if (e.key === "Escape" && revertTitle()) {
						// Consumed: the edit is cancelled, focus stays in the title.
						e.preventDefault();
						e.stopPropagation();
					}
				}}
			/>
			<div className="-me-1.5 flex shrink-0 items-center">
				<RowActions
					actions={headerActions}
					label={m.row_actions_for({ name: t.title })}
					className="md:size-8 md:opacity-100"
				/>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={m.action_close()}
					data-testid="task-detail-close"
					className="size-11 md:size-8"
					onClick={() => close()}
				>
					<X />
				</Button>
			</div>
		</div>
	);

	const body = (
		<div className="flex flex-col gap-6 px-4 pb-6">
			<p
				data-testid="task-visibility-context"
				className="break-words text-xs text-muted-foreground"
			>
				{list.title}
				{sourceWorkspace
					? ` / ${sourceWorkspace.kind === "personal" ? m.scope_source_personal({ workspace: sourceWorkspace.name }) : m.scope_source_shared({ workspace: sourceWorkspace.name })}`
					: ""}
			</p>
			{activation.status !== "native" && activation.status !== "active" && (
				<ImportActivationRecovery
					key={taskImportRecoveryKey(t.id, list.workspaceId, activation.status)}
					taskId={t.id}
					workspaceId={list.workspaceId}
					status={activation.status}
					open={open}
				/>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			<div className="flex flex-col gap-4">
				<Field label={m.task_field_due()}>
					<DuePicker
						key={t.id}
						dueAt={t.dueAt ?? null}
						dueAllDay={t.dueAllDay ?? null}
						done={t.done ?? false}
						disabled={!activation.canWrite}
						onSet={setDue}
						onClear={() => update({ id: t.id, dueAt: null })}
					>
						<ReminderChip task={t} />
					</DuePicker>
				</Field>

				{kind !== "checklist" && (
					<Field label={m.task_field_priority()}>
						<Select
							disabled={!activation.canWrite}
							value={String(t.priority ?? 0)}
							onValueChange={(v) => update({ id: t.id, priority: Number(v) })}
						>
							<SelectTrigger
								size="sm"
								aria-label={m.task_field_priority()}
								data-testid="task-priority"
								className="w-fit min-w-36 pointer-coarse:data-[size=sm]:h-11"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PRIORITY_ORDER.map((level) => (
									<SelectItem
										key={level}
										value={String(level)}
										data-testid={`task-priority-${level}`}
									>
										<Flag
											className={
												priorityMeta(level)?.color ?? "text-muted-foreground"
											}
										/>
										{priorityLabel(level)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				)}

				<AssigneePicker
					task={t}
					workspaceId={list.workspaceId}
					disabled={!activation.canWrite}
				/>

				{kind !== "checklist" && (
					<Field label={m.task_field_labels()}>
						<div className="flex flex-wrap items-center gap-1.5">
							{currentLabels.map((l) => (
								<Badge key={l.id} variant="secondary">
									{l.name}
								</Badge>
							))}
							<Popover>
								<PopoverTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										className="pointer-coarse:h-11"
									>
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
													{selected.has(l.id) && <Check className="size-3.5" />}
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
					</Field>
				)}
			</div>

			<label className="flex flex-col gap-1.5 text-sm">
				<span className="text-muted-foreground">{m.task_field_notes()}</span>
				<textarea
					disabled={!activation.canWrite}
					key={`notes-${t.id}`}
					defaultValue={t.notes ?? ""}
					rows={3}
					className="w-full rounded-lg border bg-transparent p-2 text-sm outline-none focus-visible:border-ring"
					onBlur={(e) => {
						const v = e.target.value;
						if (v !== (t.notes ?? "")) update({ id: t.id, notes: v || null });
					}}
				/>
			</label>

			{!isSubtask && (
				<Field label={m.task_field_subtasks()}>
					{subtasks.length > 0 && (
						<ul className="flex flex-col">
							{subtasks.map((s) => (
								<li key={s.id} className="flex items-center gap-2 py-1">
									<Checkbox
										disabled={!activationMap.canWriteTask(s.id)}
										aria-label={s.title}
										checked={s.done ?? false}
										onCheckedChange={() => {
											if (!activationMap.canWriteTask(s.id)) return;
											if (s.done) update({ id: s.id, done: false });
											else
												void run(
													zero.mutate(mutators.task.complete({ id: s.id })),
												);
										}}
										shape={checkShapeFor(kind ?? "tasks")}
										priority={checkToneFor(kind ?? "tasks", s.priority)}
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
										className="pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
										aria-label={m.task_delete_named({ title: s.title })}
										onClick={(event) =>
											void removeSubtask(s, event.currentTarget)
										}
									>
										<Trash2 />
									</Button>
								</li>
							))}
						</ul>
					)}
					<div className="flex items-center gap-1.5">
						<Input
							disabled={!activation.canWrite}
							value={newSubtask}
							placeholder={m.task_add_subtask_placeholder()}
							onChange={(e) => setNewSubtask(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") addSubtask();
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							className="pointer-coarse:h-11"
							data-testid="subtask-add"
							onClick={addSubtask}
							disabled={!activation.canWrite || !newSubtask.trim()}
						>
							{m.action_add()}
						</Button>
					</div>
				</Field>
			)}

			<div className="flex flex-col">
				<button
					type="button"
					aria-expanded={moreOpen}
					aria-controls={moreId}
					data-testid="task-more-toggle"
					className="-mx-2 flex min-h-11 items-center gap-2 rounded-lg px-2 text-start text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:min-h-9"
					onClick={toggleMore}
				>
					<ChevronRight
						aria-hidden
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
							// A closed disclosure marker points along the reading
							// direction; an open one points down in both.
							moreOpen ? "rotate-90" : "rtl:rotate-180",
						)}
					/>
					<span className="shrink-0">{m.task_detail_more()}</span>
					{!moreOpen && moreSummary && (
						<span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
							{moreSummary}
						</span>
					)}
				</button>
				{moreOpen && (
					<div
						id={moreId}
						data-testid="task-more"
						className="flex flex-col gap-5 pt-3"
					>
						{!isSubtask && (
							<RecurrenceEditor
								key={t.id}
								task={t}
								disabled={!activation.canWrite}
							/>
						)}

						{!isSubtask && t.rrule != null && kind !== "habits" && (
							<Button
								disabled={!activation.canWrite}
								variant="outline"
								size="sm"
								className="self-start"
								data-testid="recurrence-skip"
								aria-label={m.task_skip_occurrence()}
								onClick={() => {
									if (activation.canWrite)
										void run(
											zero.mutate(mutators.task.skipOccurrence({ id: t.id })),
										);
								}}
							>
								<SkipForward /> {m.task_skip_occurrence()}
							</Button>
						)}

						{!isSubtask && (
							<ReminderPolicy
								key={`reminder-${t.id}`}
								task={t}
								workspaceId={list.workspaceId}
								disabled={!activation.canWrite}
							/>
						)}

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

						<AttachmentList
							workspaceId={list.workspaceId}
							parentKind="task"
							parentId={t.id}
						/>

						{!isSubtask && moveTargets.length > 0 && (
							<Field label={m.task_move_to_list()}>
								<Select
									disabled={!canMove}
									value={list.id}
									onValueChange={(target) => {
										if (!canMove) return;
										const targetTasks = allTasks.filter(
											(x) => x.listId === target && x.parentId == null,
										);
										const from = { listId: t.listId, sortKey: t.sortKey };
										const move = zero.mutate(
											mutators.task.move({
												id: t.id,
												listId: target,
												sortKey: tailKey(targetTasks),
											}),
										);
										void run(move);
										onMutationFailure(move, () =>
											snackbar.fail({
												key: t.id,
												message: m.snackbar_task_move_failed({
													title: t.title,
												}),
											}),
										);
										snackbar.show({
											key: t.id,
											message: m.snackbar_task_moved({
												title: t.title,
												list:
													moveTargets.find((l) => l.id === target)?.title ?? "",
											}),
											// Back to the same list and the same place in it.
											action: {
												label: m.action_undo(),
												run: () => {
													snackbar.dismissKey(t.id);
													void run(
														zero.mutate(
															mutators.task.move({ id: t.id, ...from }),
														),
													);
												},
											},
										});
										close({ leaving: true });
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
							</Field>
						)}
					</div>
				)}
			</div>

			<div className="border-t pt-4">
				<CommentThread task={t} workspaceId={list.workspaceId} />
			</div>
		</div>
	);

	if (docked) {
		return (
			// Non-modal: the list beside it stays readable and clickable, and
			// clicking another row swaps this panel's task.
			<div
				ref={panelRef}
				role="dialog"
				aria-label={m.task_detail_title()}
				data-task-panel=""
				data-testid="task-detail"
				tabIndex={-1}
				className="fixed inset-y-0 end-0 z-30 flex w-96 flex-col border-s bg-background outline-none animate-in fade-in-0 slide-in-from-end-6 duration-(--motion-slow) ease-(--motion-ease) motion-reduce:animate-none xl:w-110"
				onKeyDown={(e) => {
					if (e.key !== "Escape" || e.defaultPrevented) return;
					e.preventDefault();
					if (!leaveField()) close();
				}}
			>
				{header}
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
					{body}
				</div>
			</div>
		);
	}

	return (
		<Sheet
			open
			onOpenChange={(o) => {
				if (!o) close();
			}}
		>
			<SheetContent
				ref={panelRef}
				side="bottom"
				showCloseButton={false}
				data-testid="task-detail"
				className="max-h-[90dvh] gap-0 overflow-y-auto outline-none"
				// The sheet traps focus; land on the sheet itself so the title is
				// not focused (and text-selected) on open.
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					focusSurface();
				}}
				onEscapeKeyDown={(e) => {
					if (leaveField()) e.preventDefault();
				}}
			>
				<SheetTitle className="sr-only">{m.task_detail_title()}</SheetTitle>
				{header}
				{body}
			</SheetContent>
		</Sheet>
	);
}
