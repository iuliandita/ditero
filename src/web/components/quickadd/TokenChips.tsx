import { CalendarClock, Flag, Hash, ListTodo, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { QuickAddToken } from "../../../domain/quick-add.ts";

const ICONS = {
	date: CalendarClock,
	priority: Flag,
	label: Hash,
	list: ListTodo,
} as const;

// Consumed parser tokens shown as removable chips. An unknown #label renders in
// a dashed "create" state (it will be created on submit). Removing a chip is
// wired by the parent to splice the token's original-input span back out.
export function TokenChips({
	tokens,
	unknownLabels,
	onRemove,
}: {
	tokens: QuickAddToken[];
	unknownLabels: Set<string>;
	onRemove: (token: QuickAddToken) => void;
}) {
	if (tokens.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5" data-testid="quickadd-chips">
			{tokens.map((tk) => {
				const Icon = ICONS[tk.type];
				const unknown =
					tk.type === "label" &&
					unknownLabels.has(tk.text.slice(1).toLowerCase());
				return (
					<Badge
						// Spans never overlap, so the start offset is a stable unique key.
						key={`${tk.type}-${tk.start}`}
						variant={unknown ? "outline" : "secondary"}
						data-testid={`chip-${tk.type}`}
						className={unknown ? "border-dashed" : undefined}
					>
						{unknown ? <Plus /> : <Icon />}
						{tk.text}
						<button
							type="button"
							aria-label={`Remove ${tk.text}`}
							onClick={() => onRemove(tk)}
							className="-me-1 ms-0.5 rounded-full hover:bg-black/10"
						>
							<X className="size-3" />
						</button>
					</Badge>
				);
			})}
		</div>
	);
}
