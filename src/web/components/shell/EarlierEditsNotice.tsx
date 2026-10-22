import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";

// Shown again on every start while the earlier database still holds edits, or
// while the check for them could not finish.
export function EarlierEditsNotice({
	found,
	incomplete,
	onDismiss,
}: {
	found: boolean;
	incomplete: boolean;
	onDismiss: () => void;
}) {
	return (
		<div
			role="alert"
			data-testid="earlier-unsynced-edits"
			className="fixed inset-x-2 top-2 z-50 mx-auto flex max-w-lg gap-3 rounded-md border border-warning bg-background p-3 text-sm shadow-lg"
		>
			<TriangleAlert
				aria-hidden
				className="mt-0.5 size-4 shrink-0 text-warning"
			/>
			<div className="flex flex-col gap-2">
				<p className="font-medium">
					{found
						? m.sync_earlier_edits_title()
						: m.sync_earlier_edits_incomplete_title()}
				</p>
				{found && (
					<p className="text-muted-foreground">
						{m.sync_earlier_edits_detail()}
					</p>
				)}
				{incomplete && (
					<p className="text-muted-foreground">
						{m.sync_earlier_edits_incomplete_detail()}
					</p>
				)}
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					onClick={onDismiss}
				>
					{m.sync_rejected_dismiss()}
				</Button>
			</div>
		</div>
	);
}
