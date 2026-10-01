import { useMemo } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { Binding } from "../../domain/keymap.ts";
import { m } from "../../paraglide/messages.js";
import { formatBinding } from "./binding-label.ts";
import { categoryLabel } from "./category-label.ts";
import { COMMANDS } from "./commands.ts";
import { useEffectiveKeymap } from "./useEffectiveKeymap.ts";

export function CheatSheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const keymap = useEffectiveKeymap();

	// Group commands that have at least one effective binding by category, keeping
	// the registry's category order.
	const groups = useMemo(() => {
		const byCategory = new Map<
			string,
			{ id: string; label: string; bindings: Binding[] }[]
		>();
		for (const cmd of COMMANDS) {
			const bindings = keymap[cmd.id] ?? [];
			if (bindings.length === 0) continue;
			const rows = byCategory.get(cmd.category) ?? [];
			rows.push({ id: cmd.id, label: cmd.label, bindings });
			byCategory.set(cmd.category, rows);
		}
		return [...byCategory.entries()];
	}, [keymap]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m.cheatsheet_title()}</DialogTitle>
					<DialogDescription>{m.cheatsheet_description()}</DialogDescription>
				</DialogHeader>
				{/* The list outgrows short viewports and holds nothing focusable, so
				    the scroll container itself takes focus for keyboard scrolling. */}
				<section
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to be keyboard-scrollable
					tabIndex={0}
					aria-label={m.cheatsheet_title()}
					className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
				>
					{groups.map(([category, rows]) => (
						<section key={category}>
							<h3 className="mb-1 text-xs font-medium text-muted-foreground">
								{categoryLabel(category)}
							</h3>
							<ul className="flex flex-col gap-1">
								{rows.map((row) => (
									<li
										key={row.id}
										className="flex items-center justify-between gap-4"
									>
										<span className="text-sm">{row.label}</span>
										<span className="flex shrink-0 gap-1">
											{row.bindings.map((b) => (
												<kbd
													key={b.join("+")}
													className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
												>
													{formatBinding(b)}
												</kbd>
											))}
										</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</section>
			</DialogContent>
		</Dialog>
	);
}
