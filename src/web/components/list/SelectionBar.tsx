import {
	CalendarDays,
	CircleCheck,
	Flag,
	FolderInput,
	type LucideIcon,
	Trash2,
	X,
} from "lucide-react";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { priorityLabel, priorityMeta } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { DuePickerContent } from "../task/DuePicker.tsx";

const PRIORITIES = [3, 2, 1, 0];

// Icon over a short label on a phone (a five-up toolbar), icon beside it from
// md. Always named by its text, so no separate aria-label to drift.
const ACTION =
	"flex h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium text-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none md:h-8 md:flex-row md:gap-1.5 md:px-2.5 md:text-sm [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground md:[&_svg]:size-4";

function Action({
	icon: Icon,
	label,
	className,
	...props
}: React.ComponentProps<"button"> & { icon: LucideIcon; label: string }) {
	return (
		<button type="button" className={cn(ACTION, className)} {...props}>
			<Icon aria-hidden />
			<span className="max-w-full truncate">{label}</span>
		</button>
	);
}

// The bulk action bar for a list's selected rows: a floating strip above the
// tab bar on a phone, a sticky strip above the rows on desktop. Plain buttons
// in reading order; the count is announced by the list's live region.
export function SelectionBar({
	count,
	canComplete,
	showDueAndPriority,
	moveTargets,
	onComplete,
	onMove,
	onDue,
	onPriority,
	onDelete,
	onClear,
}: {
	count: number;
	canComplete: boolean;
	showDueAndPriority: boolean;
	moveTargets: { id: string; title: string }[];
	onComplete: () => void;
	onMove: (listId: string) => void;
	onDue: (date: string, time: string | null) => void;
	onPriority: (priority: number) => void;
	onDelete: () => void;
	onClear: () => void;
}) {
	const [dueOpen, setDueOpen] = useState(false);
	return (
		<section
			aria-label={m.selection_bar_label()}
			data-selection-bar
			data-testid="selection-bar"
			className="fixed inset-x-2 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-overlay md:sticky md:inset-x-auto md:top-3 md:bottom-auto md:mb-3 md:flex-row md:items-center md:gap-1 md:p-1 md:ps-3"
		>
			{/* One Clear control: beside the count on a phone, last in the row from
			    md, where this wrapper dissolves into the bar's own flex row. */}
			<div className="flex min-h-9 items-center justify-between gap-2 ps-2 md:contents">
				<p
					data-testid="selection-count"
					className="truncate text-sm font-medium tabular-nums md:flex-1"
				>
					{m.selection_count({ count })}
				</p>
				<button
					type="button"
					data-testid="selection-clear"
					aria-label={m.selection_clear()}
					onClick={onClear}
					className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none md:order-last md:size-8"
				>
					<X aria-hidden className="size-4" />
				</button>
			</div>
			<div className="grid auto-cols-fr grid-flow-col md:flex md:items-center md:gap-0.5">
				<Action
					data-testid="selection-complete"
					icon={CircleCheck}
					label={m.selection_complete()}
					disabled={!canComplete}
					onClick={onComplete}
				/>
				{moveTargets.length > 0 && (
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger asChild>
							<Action
								data-testid="selection-move"
								icon={FolderInput}
								label={m.selection_move()}
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" aria-label={m.selection_move()}>
							{moveTargets.map((l) => (
								<DropdownMenuItem
									key={l.id}
									data-testid="selection-move-target"
									onSelect={() => onMove(l.id)}
								>
									<span className="truncate">{l.title}</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				{showDueAndPriority && (
					<Popover open={dueOpen} onOpenChange={setDueOpen}>
						<PopoverTrigger asChild>
							<Action
								data-testid="selection-due"
								icon={CalendarDays}
								label={m.selection_due()}
							/>
						</PopoverTrigger>
						<DuePickerContent
							selected={null}
							hasDue
							onPick={(date, time) => {
								onDue(date, time);
								setDueOpen(false);
							}}
							onClear={() => {
								onDue("", null);
								setDueOpen(false);
							}}
						/>
					</Popover>
				)}
				{showDueAndPriority && (
					<DropdownMenu modal={false}>
						<DropdownMenuTrigger asChild>
							<Action
								data-testid="selection-priority"
								icon={Flag}
								label={m.selection_priority()}
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							aria-label={m.selection_priority()}
						>
							{PRIORITIES.map((level) => {
								const meta = priorityMeta(level);
								return (
									<DropdownMenuItem
										key={level}
										data-testid={`selection-priority-${level}`}
										onSelect={() => onPriority(level)}
									>
										<Flag
											aria-hidden
											className={cn(
												"size-4",
												meta ? meta.color : "text-muted-foreground",
											)}
										/>
										{priorityLabel(level)}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
				<Action
					data-testid="selection-delete"
					icon={Trash2}
					label={m.selection_delete()}
					onClick={onDelete}
					className="text-destructive [&_svg]:text-destructive"
				/>
			</div>
		</section>
	);
}
