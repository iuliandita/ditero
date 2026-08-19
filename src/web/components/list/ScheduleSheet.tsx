import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";

// Quick due-date picker opened by a left-swipe on a task (design 2.6). Non-
// destructive snooze targets; a full editor lives in TaskDetail. Buttons carry
// all-day or timed semantics matching the parser/detail conventions. The three
// presets are exported so the row-actions Schedule submenu offers the same
// vocabulary instead of a second one.
export function todayEvening(): { dueAt: number; dueAllDay: boolean } {
	const d = new Date();
	d.setHours(18, 0, 0, 0);
	return { dueAt: d.getTime(), dueAllDay: false };
}
export function tomorrow(): { dueAt: number; dueAllDay: boolean } {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(0, 0, 0, 0);
	return { dueAt: d.getTime(), dueAllDay: true };
}
export function thisWeekend(): { dueAt: number; dueAllDay: boolean } {
	const d = new Date();
	// Next Saturday (day 6); if already Saturday, keep today.
	const delta = (6 - d.getDay() + 7) % 7;
	d.setDate(d.getDate() + delta);
	d.setHours(0, 0, 0, 0);
	return { dueAt: d.getTime(), dueAllDay: true };
}

export function ScheduleSheet({
	task,
	open,
	onOpenChange,
	onPick,
}: {
	task: Task | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onPick: (dueAt: number, dueAllDay: boolean) => void;
}) {
	function pick(v: { dueAt: number; dueAllDay: boolean }) {
		onPick(v.dueAt, v.dueAllDay);
		onOpenChange(false);
	}
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="bottom">
				<SheetHeader>
					<SheetTitle>
						{task
							? m.schedule_sheet_title_task({ title: task.title })
							: m.schedule_sheet_title()}
					</SheetTitle>
				</SheetHeader>
				<div className="flex flex-col gap-2 p-4 pt-0">
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(todayEvening())}
					>
						{m.schedule_today_evening()}
					</Button>
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(tomorrow())}
					>
						{m.schedule_tomorrow()}
					</Button>
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(thisWeekend())}
					>
						{m.schedule_this_weekend()}
					</Button>
					<input
						type="date"
						aria-label={m.schedule_pick_date()}
						className="h-9 rounded-lg border bg-transparent px-3 text-base md:text-sm"
						onChange={(e) => {
							if (!e.target.value) return;
							const [y, mo, d] = e.target.value.split("-").map(Number);
							pick({
								dueAt: new Date(y, mo - 1, d).getTime(),
								dueAllDay: true,
							});
						}}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
