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
import { COMMANDS } from "./commands.ts";
import { useEffectiveKeymap } from "./useEffectiveKeymap.ts";

// Getters: this map is module-level, so resolving the messages eagerly would
// freeze them at the import-time locale.
const CATEGORY_LABEL: Record<string, string> = {
	get general() {
		return m.cheatsheet_category_general();
	},
	get task() {
		return m.cheatsheet_category_task();
	},
	get view() {
		return m.cheatsheet_category_view();
	},
	get nav() {
		return m.cheatsheet_category_nav();
	},
	get help() {
		return m.cheatsheet_category_help();
	},
};

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
			<DialogContent className="max-w-md sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m.cheatsheet_title()}</DialogTitle>
					<DialogDescription>{m.cheatsheet_description()}</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
					{groups.map(([category, rows]) => (
						<section key={category}>
							<h3 className="mb-1 text-xs font-medium text-muted-foreground">
								{CATEGORY_LABEL[category] ?? category}
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
				</div>
			</DialogContent>
		</Dialog>
	);
}
