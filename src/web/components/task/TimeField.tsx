import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { formatTimeValue, parseTimeText } from "../../lib/date-picker.ts";

/**
 * A typed time in place of `<input type=time>`, whose segmented spinner ignores
 * the app locale and reads as a browser widget. Accepts "17:30", "5:30 pm",
 * "5pm", "1730"; commits the stored `HH:MM` form on blur or Enter, and an empty
 * field commits "". Unreadable text stays in the field with a stated reason
 * instead of silently reverting.
 */
export function TimeField({
	value,
	onCommit,
	label,
	disabled = false,
	className,
	"data-testid": testId,
}: {
	value: string;
	onCommit: (next: string) => void;
	label: string;
	disabled?: boolean;
	className?: string;
	"data-testid"?: string;
}) {
	const locale = getLocale();
	const shown = value ? formatTimeValue(value, locale) : "";
	const [draft, setDraft] = useState(shown);
	const [invalid, setInvalid] = useState(false);
	const editing = useRef(false);
	const errorId = useId();

	// Follow remote edits, but never under the user's cursor.
	useEffect(() => {
		if (!editing.current) {
			setDraft(shown);
			setInvalid(false);
		}
	}, [shown]);

	function commit() {
		const text = draft.trim();
		if (text === "") {
			setInvalid(false);
			if (value !== "") onCommit("");
			return;
		}
		const parsed = parseTimeText(text, locale);
		if (parsed == null) {
			setInvalid(true);
			return;
		}
		setInvalid(false);
		setDraft(formatTimeValue(parsed, locale));
		if (parsed !== value) onCommit(parsed);
	}

	return (
		<span className="flex flex-col gap-1">
			<Input
				disabled={disabled}
				value={draft}
				aria-label={label}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? errorId : undefined}
				placeholder={m.time_field_placeholder()}
				autoComplete="off"
				spellCheck={false}
				data-testid={testId}
				className={cn("h-8 w-28 pointer-coarse:h-11", className)}
				onFocus={() => {
					editing.current = true;
				}}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					editing.current = false;
					commit();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					}
				}}
			/>
			{invalid && (
				<span id={errorId} className="text-xs text-destructive">
					{m.time_field_invalid({
						example: formatTimeValue("17:30", locale),
					})}
				</span>
			)}
		</span>
	);
}
