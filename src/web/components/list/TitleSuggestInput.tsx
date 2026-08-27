import { useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
	suggestTitles,
	type TitleCandidate,
} from "../../../domain/title-suggest.ts";
import { m } from "../../../paraglide/messages.js";

// The add-item field with a listbox of titles the user has written before.
// Accepting one only fills the field: it is still parsed on submit like typed
// text, so a suggestion carrying "#label" or a date behaves exactly as if it
// had been typed, rather than acquiring metadata silently or losing it.
export function TitleSuggestInput({
	value,
	onChange,
	onSubmit,
	candidates,
	listId,
	placeholder,
	inputRef,
	"data-testid": testId,
	className,
}: {
	value: string;
	onChange: (next: string) => void;
	onSubmit: () => void;
	candidates: readonly TitleCandidate[];
	listId: string;
	placeholder: string;
	inputRef?: React.RefObject<HTMLInputElement | null>;
	"data-testid"?: string;
	className?: string;
}) {
	const baseId = useId();
	const listboxId = `${baseId}-listbox`;
	// Set when a suggestion is accepted, so the field does not immediately
	// re-offer suggestions for the text it just filled in.
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState(-1);
	const localRef = useRef<HTMLInputElement>(null);
	const ref = inputRef ?? localRef;

	const suggestions = useMemo(
		() => (dismissed ? [] : suggestTitles(value, candidates, { listId })),
		[dismissed, value, candidates, listId],
	);
	const open = suggestions.length > 0;
	const activeId = active >= 0 ? `${baseId}-option-${active}` : undefined;

	function accept(title: string) {
		onChange(title);
		setDismissed(true);
		setActive(-1);
		ref.current?.focus();
	}

	function change(next: string) {
		setDismissed(false);
		setActive(-1);
		onChange(next);
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Escape" && open) {
			event.preventDefault();
			setDismissed(true);
			setActive(-1);
			return;
		}
		if (event.key === "ArrowDown" && open) {
			event.preventDefault();
			setActive((i) => (i + 1) % suggestions.length);
			return;
		}
		if (event.key === "ArrowUp" && open) {
			event.preventDefault();
			setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
			return;
		}
		if (event.key !== "Enter") return;
		const picked = active >= 0 ? suggestions[active] : undefined;
		if (picked !== undefined) {
			event.preventDefault();
			accept(picked);
			return;
		}
		onSubmit();
	}

	return (
		<div className={cn("relative flex-1", className)}>
			<input
				ref={ref}
				data-testid={testId}
				role="combobox"
				aria-expanded={open}
				aria-controls={listboxId}
				aria-autocomplete="list"
				aria-activedescendant={activeId}
				className="h-9 w-full rounded-lg border bg-transparent px-3 text-base md:text-sm"
				placeholder={placeholder}
				value={value}
				onChange={(e) => change(e.target.value)}
				onKeyDown={onKeyDown}
			/>
			{/* Rendered only when populated: an empty listbox announced as a
			    combobox popup is a promise of options that do not exist. */}
			{open && (
				<div
					id={listboxId}
					role="listbox"
					aria-label={m.title_suggest_label()}
					data-testid="title-suggestions"
					className="absolute z-50 mt-1 w-full overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
				>
					{suggestions.map((title, index) => (
						<button
							key={title}
							type="button"
							id={`${baseId}-option-${index}`}
							role="option"
							aria-selected={index === active}
							data-testid="title-suggestion"
							// The field must not blur before the click lands, or
							// accept() would refocus an input the browser has already
							// moved away from.
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => accept(title)}
							className={cn(
								"flex min-h-9 w-full items-center truncate rounded-md px-2 text-start text-sm",
								index === active ? "bg-muted" : "hover:bg-muted/60",
							)}
						>
							{title}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
