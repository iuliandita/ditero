import { Plus } from "lucide-react";
import { type FocusEvent, useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { checkShapeFor } from "@/lib/check-shape";
import {
	CHECK_POP,
	strikeClass,
	useJustCompleted,
} from "@/lib/completion-feedback";
import { formatAmount } from "@/lib/shopping-list";
import { cn } from "@/lib/utils";
import {
	isValidQuantity,
	isValidUnit,
	QUANTITY_MAX_LENGTH,
	UNIT_MAX_LENGTH,
} from "../../../domain/quantity.ts";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { useTaskImportActivation } from "../../hooks/useTaskImportActivation.ts";

export type ShoppingHandlers = {
	onToggle: (id: string, done: boolean) => void;
	onOpenDetail: (task: Task) => void;
	onUpdate: (id: string, patch: { quantity?: string; unit?: string }) => void;
};

const FIELD =
	"h-9 rounded-md border border-input bg-transparent px-2 text-base md:h-7 md:text-sm";

// Quantity stays out of the way until it means something: a quiet chip once
// set, an "add quantity" affordance otherwise (revealed on hover/focus from md,
// always reachable on touch). Either opens the two fields in place.
export function ShoppingRow({
	task,
	handlers,
}: {
	task: Task;
	handlers: ShoppingHandlers;
}) {
	const activation = useTaskImportActivation(task.id);
	const justCompleted = useJustCompleted(task.done ?? false);
	const [editing, setEditing] = useState(false);
	const [invalid, setInvalid] = useState(false);
	const errorId = useId();
	const qtyRef = useRef<HTMLInputElement>(null);
	const unitRef = useRef<HTMLInputElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const returnFocus = useRef(false);
	// Unmounting the focused field can fire a late blur; only the first close counts.
	const open = useRef(false);
	const amount = formatAmount(task.quantity, task.unit);

	useEffect(() => {
		open.current = editing;
		if (editing) qtyRef.current?.focus();
		else if (returnFocus.current) {
			returnFocus.current = false;
			triggerRef.current?.focus();
		}
	}, [editing]);

	// Commit only real changes so closing the fields untouched fires nothing.
	// An invalid new quantity keeps the fields open with the reason beside them;
	// an unchanged stored value is never re-checked, so old free text survives.
	function finish(save: boolean, refocus: boolean) {
		if (!open.current) return;
		if (save) {
			const patch: { quantity?: string; unit?: string } = {};
			const quantity = qtyRef.current?.value.trim() ?? "";
			const unit = unitRef.current?.value.trim() ?? "";
			const quantityChanged = quantity !== (task.quantity ?? "");
			if (
				(quantityChanged && !isValidQuantity(quantity)) ||
				!isValidUnit(unit)
			) {
				setInvalid(true);
				if (refocus) qtyRef.current?.focus();
				return;
			}
			if (quantityChanged) patch.quantity = quantity;
			if (unit !== (task.unit ?? "")) patch.unit = unit;
			if (Object.keys(patch).length > 0) handlers.onUpdate(task.id, patch);
		}
		open.current = false;
		setInvalid(false);
		returnFocus.current = refocus;
		setEditing(false);
	}

	function onFieldsBlur(e: FocusEvent<HTMLFieldSetElement>) {
		if (!e.currentTarget.contains(e.relatedTarget as Node | null))
			finish(true, false);
	}

	const canEdit = activation.canWrite;
	const showAdd = !amount && !task.done && canEdit;

	return (
		<div>
			<div className="group flex min-h-12 items-center gap-2 rounded-md px-1 transition-colors duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none hover:bg-muted/30 md:min-h-10">
				<div className="flex size-11 shrink-0 items-center justify-center md:size-8">
					<Checkbox
						disabled={!canEdit}
						aria-label={task.title}
						checked={task.done ?? false}
						onCheckedChange={() =>
							handlers.onToggle(task.id, task.done ?? false)
						}
						shape={checkShapeFor("shopping")}
						className={cn(
							"after:-inset-3.5 md:after:-inset-2",
							justCompleted && CHECK_POP,
						)}
					/>
				</div>
				<button
					type="button"
					data-task-id={task.id}
					onClick={() => handlers.onOpenDetail(task)}
					className={cn(
						"min-h-11 min-w-0 flex-1 truncate text-start md:min-h-9",
						task.done && "text-muted-foreground",
					)}
				>
					<span className={strikeClass(task.done ?? false)}>{task.title}</span>
					{(activation.status === "pending" ||
						activation.status === "blocked") && (
						<span className="block text-xs text-warning">
							{activation.status === "pending"
								? m.activation_badge_pending()
								: m.activation_badge_blocked()}
						</span>
					)}
				</button>
				{editing ? (
					<fieldset
						aria-label={m.shopping_quantity_for({ title: task.title })}
						className="flex shrink-0 items-center gap-1.5"
						data-testid="shopping-qty-fields"
						onBlur={onFieldsBlur}
						onKeyDown={(e) => {
							// Focus returns to the chip inside this keydown; without
							// preventDefault the same Enter then activates it and reopens.
							// Neither key reaches the global shortcuts while editing.
							if (e.key === "Enter") {
								e.preventDefault();
								e.stopPropagation();
								finish(true, true);
							} else if (e.key === "Escape") {
								e.preventDefault();
								e.stopPropagation();
								finish(false, true);
							}
						}}
					>
						<input
							ref={qtyRef}
							defaultValue={task.quantity ?? ""}
							aria-label={m.shopping_quantity_for({ title: task.title })}
							placeholder={m.shopping_qty_placeholder()}
							inputMode="decimal"
							maxLength={QUANTITY_MAX_LENGTH}
							aria-invalid={invalid || undefined}
							aria-describedby={invalid ? errorId : undefined}
							className={cn(FIELD, "w-14 text-center")}
						/>
						<input
							ref={unitRef}
							defaultValue={task.unit ?? ""}
							aria-label={m.shopping_unit_for({ title: task.title })}
							placeholder={m.shopping_unit_placeholder()}
							maxLength={UNIT_MAX_LENGTH}
							className={cn(FIELD, "w-16")}
						/>
					</fieldset>
				) : amount ? (
					<button
						ref={triggerRef}
						type="button"
						disabled={!canEdit}
						data-testid="shopping-qty-chip"
						aria-label={m.shopping_quantity_edit({ amount, title: task.title })}
						onClick={() => setEditing(true)}
						className="flex min-h-11 shrink-0 items-center rounded-lg px-1 md:min-h-8 disabled:cursor-default"
					>
						<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
							{amount}
						</span>
					</button>
				) : showAdd ? (
					<button
						ref={triggerRef}
						type="button"
						data-testid="shopping-qty-add"
						// Starts with the visible label so voice control can say what it sees.
						aria-label={m.shopping_quantity_add({
							label: m.shopping_qty_placeholder(),
							title: task.title,
						})}
						onClick={() => setEditing(true)}
						className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-[opacity,color] duration-(--motion-fast) ease-(--motion-ease) hover:text-foreground motion-reduce:transition-none md:min-h-8 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
					>
						<Plus className="size-3.5" aria-hidden />
						{m.shopping_qty_placeholder()}
					</button>
				) : null}
			</div>
			{editing && invalid && (
				<p
					id={errorId}
					role="alert"
					data-testid="shopping-qty-error"
					className="pb-2 ps-14 text-xs text-destructive md:ps-11"
				>
					{m.shopping_quantity_invalid()}
				</p>
			)}
		</div>
	);
}
