"use client";

import { MoreVertical } from "lucide-react";
import {
	Fragment,
	type MouseEvent,
	type PointerEvent,
	type TouchEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
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
import { TOUCH_KEYBOARD_ONLY } from "@/lib/touch";
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
 * The kebab. Always rendered so it is a real tab stop; on pointer devices it
 * merely fades in on hover or focus. The row container is expected to carry
 * `group`, which is what the hover reveal keys off.
 */
export function RowActions({
	actions,
	label,
	className,
	hideOnTouch = false,
}: {
	actions: RowAction[];
	/** Names the row, e.g. "Actions for Groceries". */
	label?: string;
	className?: string;
	/**
	 * On a coarse pointer the row's long-press opens this same menu, so the
	 * kebab leaves the layout and stays only as a keyboard tab stop.
	 */
	hideOnTouch?: boolean;
}) {
	const visible = visibleActions(actions);
	if (visible.length === 0) return null;
	return (
		// modal={false}: a Radix modal menu calls hideOthers(), which puts
		// aria-hidden="true" on the whole app root while every control inside it
		// stays tabbable -- a serious aria-hidden-focus violation. A dialog gets
		// away with it because it also carries aria-modal, which AT (and axe)
		// treat as the exclusion boundary; role="menu" carries no such promise. A
		// row kebab is not modal anyway. Escape, outside-click dismissal, focus
		// return to the trigger and Tab containment are all unchanged -- only the
		// aria-hidden blanket and the background scroll lock go away.
		<DropdownMenu modal={false}>
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
						// aria-expanded, not the sibling files' `data-open:`: a kebab
						// has no Radix data-state of its own until its menu mounts.
						"focus-visible:opacity-100 aria-expanded:opacity-100",
						hideOnTouch && TOUCH_KEYBOARD_ONLY,
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

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

/**
 * Right-click anywhere on the row, or a touch long-press, opens the same menu.
 * Returns props to spread on the row container plus the menu element to render
 * beside it.
 */
export function useRowContextMenu(actions: RowAction[], label?: string) {
	const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
	const [pressed, setPressed] = useState(false);
	const press = useRef<{
		x: number;
		y: number;
		timer: ReturnType<typeof setTimeout>;
		held: boolean;
	} | null>(null);
	const released = useRef(false);
	const visible = visibleActions(actions);

	function cancelPress() {
		if (press.current) clearTimeout(press.current.timer);
		press.current = null;
		setPressed(false);
	}
	useEffect(
		() => () => {
			if (press.current) clearTimeout(press.current.timer);
		},
		[],
	);

	return {
		rowProps: {
			"data-long-pressed": pressed || undefined,
			onContextMenu: (event: MouseEvent) => {
				if (visible.length === 0) return;
				event.preventDefault();
				// Android raises contextmenu for a held finger; the long-press path
				// owns touch and opens on release, so the lifting finger cannot land
				// on a menu item that appeared under it.
				if (press.current) return;
				setPoint({ x: event.clientX, y: event.clientY });
			},
			onPointerDown: (event: PointerEvent) => {
				cancelPress();
				released.current = false;
				if (event.pointerType !== "touch" || visible.length === 0) return;
				const at = {
					x: event.clientX,
					y: event.clientY,
					held: false,
					timer: setTimeout(() => {
						if (!press.current) return;
						press.current.held = true;
						setPressed(true);
					}, LONG_PRESS_MS),
				};
				press.current = at;
			},
			onPointerMove: (event: PointerEvent) => {
				const at = press.current;
				if (!at || at.held) return;
				if (
					Math.hypot(event.clientX - at.x, event.clientY - at.y) >
					LONG_PRESS_SLOP
				)
					cancelPress();
			},
			onPointerUp: () => {
				const at = press.current;
				cancelPress();
				if (!at?.held) return;
				released.current = true;
				setPoint({ x: at.x, y: at.y });
			},
			onPointerCancel: cancelPress,
			// The lift after a long-press would otherwise become a tap: its
			// compatibility mousedown moves focus out of the just-opened menu (a
			// non-modal menu closes on that) and its click opens the row behind.
			// Cancelling touchend suppresses both at the source.
			onTouchEnd: (event: TouchEvent) => {
				if (!released.current) return;
				released.current = false;
				event.preventDefault();
			},
		},
		menu:
			point && visible.length > 0 ? (
				<DropdownMenu
					open
					modal={false}
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
						// Clear of the point, so a long-press's lifted finger is never
						// over an item.
						sideOffset={12}
						aria-label={label ?? m.row_actions_label()}
					>
						<Items actions={visible} />
					</DropdownMenuContent>
				</DropdownMenu>
			) : null,
	};
}
