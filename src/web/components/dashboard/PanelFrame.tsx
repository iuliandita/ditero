import type {
	DraggableAttributes,
	DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
	Check,
	GripVertical,
	MoreHorizontal,
	Pencil,
	Trash2,
} from "lucide-react";
import type { JSX, ReactNode } from "react";
import {
	PANEL_SPANS,
	type Panel,
	type PanelSize,
} from "../../../domain/dashboard.ts";
import { Button } from "../ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";

// Derived fallback per shell doc §1: view name for source panels (passed in as
// viewName), "N habits" / "Focus today" for the data-bound types.
function derivedLabel(panel: Panel): string {
	switch (panel.type) {
		case "tasks":
			return "Tasks";
		case "counter":
			return "Counter";
		case "streak":
			return `${panel.habitIds.length} habit${panel.habitIds.length === 1 ? "" : "s"}`;
		case "focus":
			return panel.range === "today" ? "Focus today" : "Focus this week";
		default:
			return panel satisfies never;
	}
}

// Region label: user title, else the referenced view's name, else derived.
export function panelLabel(panel: Panel, viewName?: string | null): string {
	return panel.title || viewName || derivedLabel(panel);
}

const SIZES = Object.keys(PANEL_SPANS) as PanelSize[];
export const SIZE_LABEL: Record<PanelSize, string> = {
	s: "Small",
	m: "Medium",
	l: "Large",
	full: "Full width",
};

// Slim always-on panel chrome (shell doc §1): the header is the accessible
// region label, and in edit mode doubles as the drag handle; the "..." menu
// (resize/remove) renders in edit mode only.
export function PanelFrame({
	panel,
	editing,
	handle,
	viewName,
	onEdit,
	onResize,
	onRemove,
	children,
}: {
	panel: Panel;
	editing: boolean;
	handle?: {
		attributes: DraggableAttributes;
		listeners: DraggableSyntheticListeners;
	};
	viewName?: string | null;
	onEdit?: () => void;
	onResize?: (size: PanelSize) => void;
	onRemove?: () => void;
	children: ReactNode;
}): JSX.Element {
	const label = panelLabel(panel, viewName);
	return (
		<section
			aria-label={label}
			data-testid="panel-frame"
			className="flex h-full flex-col rounded-lg border bg-card"
		>
			<header className="flex items-center gap-1 px-3 py-2">
				{editing && handle ? (
					<button
						type="button"
						data-testid="panel-drag"
						aria-label={`Move ${label} panel`}
						className="flex min-w-0 flex-1 cursor-grab touch-none items-center gap-1.5 rounded text-start focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						{...handle.attributes}
						{...handle.listeners}
					>
						<GripVertical className="size-3.5 shrink-0 text-muted-foreground/60" />
						<span className="truncate text-xs font-medium text-muted-foreground">
							{label}
						</span>
					</button>
				) : (
					<span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
						{label}
					</span>
				)}
				{editing && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`${label} panel actions`}
								data-testid="panel-menu"
							>
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{onEdit && (
								<DropdownMenuItem data-testid="panel-edit" onSelect={onEdit}>
									<Pencil /> Edit panel
								</DropdownMenuItem>
							)}
							<DropdownMenuSub>
								<DropdownMenuSubTrigger data-testid="panel-resize">
									Resize
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent>
									{SIZES.map((size) => (
										<DropdownMenuItem
											key={size}
											data-testid={`panel-size-${size}`}
											onSelect={() => onResize?.(size)}
										>
											{SIZE_LABEL[size]}
											{panel.size === size && <Check className="ml-auto" />}
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								data-testid="panel-remove"
								className="text-destructive"
								onSelect={() => {
									if (window.confirm("Remove this panel?")) onRemove?.();
								}}
							>
								<Trash2 /> Remove
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</header>
			<div className="flex-1 px-3 pb-3">{children}</div>
		</section>
	);
}
