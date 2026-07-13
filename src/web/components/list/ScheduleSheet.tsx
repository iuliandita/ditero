import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { Task } from "../../../zero/schema.gen.ts";

// Quick due-date picker opened by a left-swipe on a task (design 2.6). Non-
// destructive snooze targets; a full editor lives in TaskDetail. Buttons carry
// all-day or timed semantics matching the parser/detail conventions.
function todayEvening(): { dueAt: number; dueAllDay: boolean } {
	const d = new Date();
	d.setHours(18, 0, 0, 0);
	return { dueAt: d.getTime(), dueAllDay: false };
}
function tomorrow(): { dueAt: number; dueAllDay: boolean } {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(0, 0, 0, 0);
	return { dueAt: d.getTime(), dueAllDay: true };
}
function thisWeekend(): { dueAt: number; dueAllDay: boolean } {
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
					<SheetTitle>Schedule{task ? `: ${task.title}` : ""}</SheetTitle>
				</SheetHeader>
				<div className="flex flex-col gap-2 p-4 pt-0">
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(todayEvening())}
					>
						Today evening
					</Button>
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(tomorrow())}
					>
						Tomorrow
					</Button>
					<Button
						variant="outline"
						className="justify-start"
						onClick={() => pick(thisWeekend())}
					>
						This weekend
					</Button>
					<input
						type="date"
						aria-label="Pick a due date"
						className="h-9 rounded-lg border bg-transparent px-3 text-base md:text-sm"
						onChange={(e) => {
							if (!e.target.value) return;
							const [y, m, d] = e.target.value.split("-").map(Number);
							pick({
								dueAt: new Date(y, m - 1, d).getTime(),
								dueAllDay: true,
							});
						}}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
}
