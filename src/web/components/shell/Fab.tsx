import { Plus } from "lucide-react";
import { m } from "../../../paraglide/messages.js";

// Floating action button: bottom-right, above the tab bar (not center-docked).
// Lists keep their own add field clear of it; + stays the touch route to quick add
// (dictation, syntax help) from any page.
export function Fab({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			type="button"
			aria-label={m.fab_quick_add()}
			onClick={onOpen}
			className="fixed end-4 bottom-20 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-floating transition-transform duration-(--motion-fast) ease-(--motion-ease) active:scale-95 motion-reduce:transition-none mb-[env(safe-area-inset-bottom)] [body:has([data-selection-bar])_&]:hidden"
		>
			<Plus className="size-6" />
		</button>
	);
}
