import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { useSyncStatus } from "../../hooks/useSyncStatus.ts";
import type { SyncPhase } from "../../lib/sync-status.ts";
import { PHASE, requestSyncDetails } from "./SyncIndicator.tsx";

// Only the states where an edit can be lost if the app closes. Everything else
// stays in the quiet icon. Display only: it never offers reload or sign-out,
// because retiring the client could discard edits that exist nowhere else.
const URGENT: ReadonlySet<SyncPhase> = new Set([
	"storage-offline",
	"storage-reauth",
	"storage-failed",
]);

export function SyncNotice() {
	const { phase, pending } = useSyncStatus();
	if (!URGENT.has(phase)) return null;
	const copy = PHASE[phase];
	return (
		<section
			aria-label={copy.title()}
			data-testid="sync-notice"
			data-phase={phase}
			className="mx-4 mt-3 flex gap-3 rounded-lg border border-warning p-3 text-sm md:mx-6"
		>
			<TriangleAlert
				aria-hidden
				className="mt-0.5 size-4 shrink-0 text-warning"
			/>
			<div className="flex min-w-0 flex-col gap-1">
				<p className="font-medium">{copy.title()}</p>
				<p className="text-muted-foreground">{copy.detail()}</p>
				{pending > 0 && (
					<p
						data-testid="sync-notice-pending"
						className="text-xs text-muted-foreground tabular-nums"
					>
						{m.sync_pending_count({ count: pending })}
					</p>
				)}
				<Button
					variant="outline"
					size="sm"
					className="mt-1 min-h-11 self-start md:min-h-8"
					data-testid="sync-notice-details"
					onClick={requestSyncDetails}
				>
					{m.sync_details_action()}
				</Button>
			</div>
		</section>
	);
}
