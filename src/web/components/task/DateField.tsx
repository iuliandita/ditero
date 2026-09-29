import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { dayKey, parseDayKey } from "../../lib/date-picker.ts";
import { formatDayKey } from "../../lib/intl-format.ts";
import { MonthGrid, QuickPicks, TypedDate } from "./DuePicker.tsx";

/**
 * A plain calendar day (`YYYY-MM-DD`, or "" for none) with the due picker's
 * typed field, quick picks and month grid, in place of `<input type=date>`,
 * whose widget ignores the app locale and theme.
 */
export function DateField({
	value,
	onCommit,
	label,
	placeholder,
	disabled = false,
	"data-testid": testId,
}: {
	value: string;
	onCommit: (next: string) => void;
	label: string;
	placeholder: string;
	disabled?: boolean;
	"data-testid"?: string;
}) {
	const [open, setOpen] = useState(false);
	const shown = value
		? formatDayKey(value, { dateStyle: "medium" })
		: placeholder;

	function pick(next: string) {
		if (next !== value) onCommit(next);
		setOpen(false);
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					disabled={disabled}
					variant="outline"
					data-testid={testId}
					data-value={value || undefined}
					aria-label={m.date_field_trigger_aria({ label, value: shown })}
					className={cn(
						"w-fit pointer-coarse:h-11",
						!value && "text-muted-foreground",
					)}
				>
					<CalendarDays />
					{shown}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-72 gap-2 p-2 pointer-coarse:w-[21rem]"
				data-testid={testId ? `${testId}-content` : undefined}
				aria-label={label}
				onOpenAutoFocus={(e) => {
					if (window.matchMedia("(pointer: coarse)").matches)
						e.preventDefault();
				}}
			>
				<TypedDate label={label} onPick={(date) => pick(date)} />
				<QuickPicks
					hasDue={value !== ""}
					onPick={pick}
					onClear={() => pick("")}
				/>
				<MonthGrid
					selected={value ? parseDayKey(value) : null}
					onPick={(d) => pick(dayKey(d))}
				/>
			</PopoverContent>
		</Popover>
	);
}
