import {
	CalendarClock,
	Flag,
	Hash,
	ListTodo,
	Plus,
	Scale,
	X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	priorityFromToken,
	type QuickAddToken,
} from "../../../domain/quick-add.ts";
import { m } from "../../../paraglide/messages.js";
import { priorityLabel } from "../../lib/task-display.ts";
import { cn } from "../../lib/utils.ts";

const ICONS = {
	date: CalendarClock,
	priority: Flag,
	label: Hash,
	list: ListTodo,
	quantity: Scale,
} as const;

// Consumed parser tokens shown as removable chips. An unknown #label renders in
// a dashed "create" state (it will be created on submit). Removing a chip is
// wired by the parent to splice the token's original-input span back out.
export function TokenChips({
	tokens,
	unknownLabels,
	onRemove,
	removeLabel = (token) => m.quickadd_chip_remove({ token }),
}: {
	tokens: QuickAddToken[];
	unknownLabels: Set<string>;
	onRemove: (token: QuickAddToken) => void;
	/** Accessible name of the chip's button, for surfaces where it does not delete the text. */
	removeLabel?: (token: string) => string;
}) {
	if (tokens.length === 0) return null;
	return (
		<div className="flex shrink-0 gap-1.5" data-testid="quickadd-chips">
			{tokens.map((tk) => {
				const Icon = ICONS[tk.type];
				const unknown =
					tk.type === "label" &&
					unknownLabels.has(tk.text.slice(1).toLowerCase());
				// Priority chips name the level the way every picker does ("P1 High").
				const level =
					tk.type === "priority" ? priorityFromToken(tk.text) : null;
				return (
					<Badge
						// Spans never overlap, so the start offset is a stable unique key.
						key={`${tk.type}-${tk.start}`}
						variant={unknown ? "outline" : "secondary"}
						data-testid={`chip-${tk.type}`}
						className={cn(
							"h-11 shrink-0 overflow-visible",
							unknown && "border-dashed",
						)}
					>
						{unknown ? <Plus /> : <Icon />}
						{level != null ? priorityLabel(level) : <bdi>{tk.text}</bdi>}
						<button
							type="button"
							// `tk.text` is the verbatim input span (sigil included), never translated.
							aria-label={removeLabel(tk.text)}
							onClick={() => onRemove(tk)}
							className="-me-1 ms-0.5 flex min-h-11 min-w-11 items-center justify-center rounded-full hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<X className="size-3" />
						</button>
					</Badge>
				);
			})}
		</div>
	);
}
