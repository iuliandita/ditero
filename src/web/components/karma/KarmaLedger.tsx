import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { KarmaEvent } from "../../../zero/schema.gen.ts";
import { reasonLabel } from "./karma-format.ts";

// Reverse-chronological karma ledger (shell doc 5): every point traces to an
// event. Undo/compensation rows are negative deltas, styled distinct from gains
// so a reversal reads as an explicit compensation, never a silent removal.
export function KarmaLedger({ events }: { events: KarmaEvent[] }) {
	const sorted = useMemo(
		() =>
			[...events].sort(
				(a, b) =>
					(b.createdAt ?? 0) - (a.createdAt ?? 0) ||
					(a.date < b.date ? 1 : a.date > b.date ? -1 : 0),
			),
		[events],
	);

	if (sorted.length === 0)
		return (
			<p
				className="text-sm text-muted-foreground"
				data-testid="karma-ledger-empty"
			>
				{m.karma_ledger_empty()}
			</p>
		);

	return (
		<ul className="flex flex-col gap-1" data-testid="karma-ledger">
			{sorted.map((e) => {
				const negative = e.delta < 0;
				return (
					<li
						key={e.id}
						data-testid="karma-ledger-row"
						className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
					>
						<span className="flex min-w-0 flex-col">
							<span className="truncate">{reasonLabel(e.reason)}</span>
							<span className="text-xs text-muted-foreground">{e.date}</span>
						</span>
						<span
							data-testid="karma-ledger-delta"
							className={cn(
								"shrink-0 font-medium tabular-nums",
								negative ? "text-destructive" : "text-success",
							)}
						>
							{negative ? "" : "+"}
							{e.delta}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
