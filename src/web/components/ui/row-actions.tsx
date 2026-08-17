"use client";

import { MoreVertical } from "lucide-react";
import { Fragment, type MouseEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuPortal,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { type RowAction, visibleActions } from "./row-action.ts";

function Item({ action }: { action: RowAction }) {
	const reasonId = useId();
	const blocked = action.disabledReason !== undefined;
	return (
		<DropdownMenuItem
			data-testid={`row-action-${action.id}`}
			// aria-disabled, NOT the native `disabled` prop: Radix skips a natively
			// disabled item in keyboard navigation, so the user could never reach it
			// to find out why it is unavailable.
			aria-disabled={blocked || undefined}
			aria-describedby={blocked ? reasonId : undefined}
			variant={action.destructive ? "destructive" : "default"}
			onSelect={(event) => {
				// Keep the menu open and fire nothing: a stale blocked item must never
				// reach the mutator and surface its untranslated server-side error in
				// place of this reason.
				if (blocked) {
					event.preventDefault();
					return;
				}
				action.onSelect?.();
			}}
		>
			{action.icon && <action.icon className="size-4" />}
			<span className="flex flex-col">
				<span className={cn(blocked && "text-muted-foreground")}>
					{action.label}
				</span>
				{action.disabledReason && (
					<span id={reasonId} className="text-xs text-muted-foreground">
						{action.disabledReason}
					</span>
				)}
			</span>
		</DropdownMenuItem>
	);
}

function Items({ actions }: { actions: RowAction[] }) {
	return (
		<>
			{actions.map((action, index) => {
				const previous = actions[index - 1];
				const separator =
					action.destructive === true &&
					previous !== undefined &&
					previous.destructive !== true;
				// Fragment, not a wrapper element: Radix collects items with a
				// descendant query so a wrapper would still navigate, but it would put
				// a generic node inside role="menu".
				return (
					<Fragment key={action.id}>
						{separator && <DropdownMenuSeparator />}
						{action.submenu ? (
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									{action.icon && <action.icon className="size-4" />}
									{action.label}
								</DropdownMenuSubTrigger>
								<DropdownMenuPortal>
									<DropdownMenuSubContent>
										<Items actions={action.submenu} />
									</DropdownMenuSubContent>
								</DropdownMenuPortal>
							</DropdownMenuSub>
						) : (
							<Item action={action} />
						)}
					</Fragment>
				);
			})}
		</>
	);
}

/**
 * The kebab. Always rendered so it is a real tab stop and a real touch target;
 * on pointer devices it merely fades in on hover or focus. The row container is
 * expected to carry `group`, which is what the hover reveal keys off.
 */
export function RowActions({
	actions,
	label,
	className,
}: {
	actions: RowAction[];
	/** Names the row, e.g. "Actions for Groceries". */
	label?: string;
	className?: string;
}) {
	const visible = visibleActions(actions);
	if (visible.length === 0) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					data-kbd-action="menu"
					data-testid="row-actions"
					aria-label={label ?? m.row_actions_label()}
					className={cn(
						// 44px tap target below md, where there is no hover to reveal it
						// and no pointer precision to aim with; the icon itself does not
						// grow.
						"size-11 md:size-7",
						"md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
						// aria-expanded, not the sibling files' `data-open:`, which
						// compiles to `[data-open]` -- an attribute Radix never sets.
						"focus-visible:opacity-100 aria-expanded:opacity-100",
						className,
					)}
					onClick={(event) => event.stopPropagation()}
				>
					<MoreVertical />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<Items actions={visible} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Right-click anywhere on the row opens the same menu. Returns props to spread
 * on the row container plus the menu element to render beside it.
 */
export function useRowContextMenu(actions: RowAction[], label?: string) {
	const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
	const visible = visibleActions(actions);
	return {
		rowProps: {
			onContextMenu: (event: MouseEvent) => {
				if (visible.length === 0) return;
				event.preventDefault();
				setPoint({ x: event.clientX, y: event.clientY });
			},
		},
		menu:
			point && visible.length > 0 ? (
				<DropdownMenu
					open
					onOpenChange={(open) => {
						if (!open) setPoint(null);
					}}
				>
					<DropdownMenuTrigger
						aria-hidden
						tabIndex={-1}
						className="pointer-events-none fixed"
						style={{ left: point.x, top: point.y }}
					/>
					<DropdownMenuContent
						align="start"
						aria-label={label ?? m.row_actions_label()}
					>
						<Items actions={visible} />
					</DropdownMenuContent>
				</DropdownMenu>
			) : null,
	};
}
