import { Plus } from "lucide-react";
import { m } from "../../../paraglide/messages.js";

// Floating action button: bottom-right, above the tab bar (not center-docked).
// Opening the quick-add sheet is Task 10's job; this just fires the seam.
export function Fab({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			type="button"
			aria-label={m.fab_quick_add()}
			onClick={onOpen}
			className="fixed end-4 bottom-20 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-floating transition-transform duration-(--motion-fast) ease-(--motion-ease) active:scale-95 motion-reduce:transition-none mb-[env(safe-area-inset-bottom)]"
		>
			<Plus className="size-6" />
		</button>
	);
}
