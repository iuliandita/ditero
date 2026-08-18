import {
	CalendarClock,
	Copy,
	Flag,
	SquareArrowOutUpRight,
	Trash2,
} from "lucide-react";
import type { ListKind } from "../../../domain/icon-map.ts";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { priorityLabel } from "../../lib/task-display.ts";
import type { RowAction } from "../ui/row-action.ts";
import { thisWeekend, todayEvening, tomorrow } from "./ScheduleSheet.tsx";

const PRIORITY_LEVELS = [0, 1, 2, 3];

export type Due = { dueAt: number; dueAllDay: boolean };

export type TaskActionHandlers = {
	open: (task: Task) => void;
	schedule: (task: Task, due: Due) => void;
	/** Opens ScheduleSheet for an arbitrary date; absent on surfaces without it. */
	pickDate: ((task: Task) => void) | undefined;
	setPriority: (task: Task, priority: number) => void;
	saveAsTemplate: (task: Task) => void;
	remove: (task: Task) => void;
};

// Plain function, not a hook, for the same reason listActions is one: rows are
// built inside render callbacks.
export function taskActions({
	task,
	kind,
	role,
	handlers,
}: {
	task: Task;
	kind: ListKind;
	role: Role | null;
	handlers: TaskActionHandlers;
}): RowAction[] {
	// task.update and task.delete both gate on requireWrite over the list's
	// workspace -- a plain write role, NOT the owner-or-admin rule list.delete
	// uses, so canActOnOwned would hide a delete the mutator would have allowed.
	const canWrite = role !== null && WRITE_ROLES.has(role);
	// Checklist rows carry no due or priority chrome anywhere else (TaskRow,
	// TaskDetail); the menu does not reintroduce them.
	const bare = kind === "checklist";
	return [
		{
			id: "open",
			label: m.action_open(),
			icon: SquareArrowOutUpRight,
			onSelect: () => handlers.open(task),
		},
		{
			id: "schedule",
			label: m.schedule_sheet_title(),
			icon: CalendarClock,
			hidden: !canWrite || bare,
			submenu: [
				{
					id: "schedule-today-evening",
					label: m.schedule_today_evening(),
					onSelect: () => handlers.schedule(task, todayEvening()),
				},
				{
					id: "schedule-tomorrow",
					label: m.schedule_tomorrow(),
					onSelect: () => handlers.schedule(task, tomorrow()),
				},
				{
					id: "schedule-this-weekend",
					label: m.schedule_this_weekend(),
					onSelect: () => handlers.schedule(task, thisWeekend()),
				},
				{
					id: "schedule-pick",
					label: m.schedule_pick_date(),
					hidden: handlers.pickDate === undefined,
					onSelect: () => handlers.pickDate?.(task),
				},
			],
		},
		{
			id: "priority",
			label: m.task_field_priority(),
			icon: Flag,
			hidden: !canWrite || bare,
			submenu: PRIORITY_LEVELS.map((level) => ({
				id: `priority-${level}`,
				label: priorityLabel(level),
				hidden: (task.priority ?? 0) === level,
				onSelect: () => handlers.setPriority(task, level),
			})),
		},
		{
			id: "save-as-template",
			label: m.action_save_task_as_template(),
			icon: Copy,
			hidden: !canWrite,
			onSelect: () => handlers.saveAsTemplate(task),
		},
		{
			id: "delete",
			label: m.action_delete(),
			icon: Trash2,
			destructive: true,
			hidden: !canWrite,
			onSelect: () => handlers.remove(task),
		},
	];
}
