import { useEffect, useRef } from "react";
import { m } from "../../../paraglide/messages.js";
import type { useAccountSetup } from "../../hooks/useAccountSetup.ts";
import { useIsDesktop } from "../../lib/use-media-query.ts";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../ui/sheet.tsx";
import { AccountSetupWizardHost } from "./AccountSetupPanel.tsx";

export type SetupDone = { workspaceId: string; listId: string };

// Focused first-run surface: a bottom sheet on phones, a dialog on desktop.
// Closing it without applying or skipping leaves the choice open.
export function AccountSetupDialog({
	setup,
	open,
	onClose,
	onDone,
}: {
	setup: ReturnType<typeof useAccountSetup>;
	open: boolean;
	onClose: () => void;
	onDone: (done: SetupDone | null) => void;
}) {
	const isDesktop = useIsDesktop();
	const finished = open && setup.state === "completed";
	const reported = useRef(false);
	useEffect(() => {
		if (!finished) {
			reported.current = false;
			return;
		}
		if (reported.current) return;
		reported.current = true;
		const listId = setup.createdLists[0];
		onDone(
			setup.outcome === "completed" && listId && setup.createdWorkspaceId
				? { workspaceId: setup.createdWorkspaceId, listId }
				: null,
		);
	}, [
		finished,
		setup.outcome,
		setup.createdLists,
		setup.createdWorkspaceId,
		onDone,
	]);

	// Neither surface has a Trigger, so Radix has nowhere to return focus: put it
	// back on the control that opened the setup, if that control is still there.
	const opener = useRef<HTMLElement | null>(null);
	const focusProps = {
		onOpenAutoFocus: () => {
			opener.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
		},
		onCloseAutoFocus: (event: Event) => {
			const target = opener.current;
			opener.current = null;
			if (target?.isConnected) {
				event.preventDefault();
				target.focus();
			}
		},
	};
	const body = (
		<AccountSetupWizardHost setup={setup} hideHeader onLeave={onClose} />
	);
	const change = (next: boolean) => {
		if (!next) onClose();
	};
	if (isDesktop)
		return (
			<Dialog open={open} onOpenChange={change}>
				<DialogContent
					{...focusProps}
					className="max-h-[85dvh] gap-0 overflow-y-auto p-0 sm:max-w-2xl"
				>
					<DialogHeader className="p-6 pe-12 pb-0">
						<DialogTitle>{m.setup_title()}</DialogTitle>
						<DialogDescription>{m.setup_description()}</DialogDescription>
					</DialogHeader>
					{body}
				</DialogContent>
			</Dialog>
		);
	return (
		<Sheet open={open} onOpenChange={change}>
			<SheetContent
				{...focusProps}
				side="bottom"
				className="max-h-[92dvh] gap-0 overflow-y-auto"
			>
				<SheetHeader className="pe-12">
					<SheetTitle>{m.setup_title()}</SheetTitle>
					<SheetDescription>{m.setup_description()}</SheetDescription>
				</SheetHeader>
				{body}
			</SheetContent>
		</Sheet>
	);
}
