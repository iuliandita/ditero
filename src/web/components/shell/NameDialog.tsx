"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { m } from "../../../paraglide/messages.js";

// One name-and-save dialog behind list rename, folder create and folder rename.
// The input stays mounted so Radix can animate the close; the seed below is
// what re-arms it, since a remount-per-open would not.
export function NameDialog({
	open,
	initialName,
	title,
	fieldLabel,
	testId,
	onSubmit,
	onOpenChange,
}: {
	open: boolean;
	initialName: string;
	title: string;
	fieldLabel: string;
	/** `${testId}-input` / `${testId}-save`. */
	testId: string;
	onSubmit: (name: string) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const [value, setValue] = useState(initialName);
	// Re-seed on open, and on a new target while open. Keyed on `open` too, so
	// reopening the same row after an edited-then-cancelled attempt starts from
	// the stored name rather than the abandoned draft.
	const [seed, setSeed] = useState({ open, initialName });
	if (seed.open !== open || seed.initialName !== initialName) {
		setSeed({ open, initialName });
		if (open) setValue(initialName);
	}

	const submit = () => {
		const next = value.trim();
		if (!next) return;
		onSubmit(next);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				<Input
					data-testid={`${testId}-input`}
					aria-label={fieldLabel}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") submit();
					}}
				/>
				<DialogFooter>
					<Button
						type="button"
						data-testid={`${testId}-save`}
						disabled={value.trim().length === 0}
						onClick={submit}
					>
						{m.submit_save_changes()}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
