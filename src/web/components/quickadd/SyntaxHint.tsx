import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { dateParserFor } from "../../../domain/quick-add.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { type SyntaxToken, syntaxTokens } from "../../lib/hints.ts";

const MEANING: Record<SyntaxToken["type"], () => string> = {
	date: m.task_due_date_aria,
	priority: m.syntax_hint_priority,
	label: m.field_label,
	list: m.field_list,
};

// A quiet legend of the quick-add grammar. Only tokens the active locale's
// parser accepts are listed: no date word where there is no date parser.
export function SyntaxHint({
	lead,
	example = false,
	onDismiss,
	className,
}: {
	lead?: ReactNode;
	example?: boolean;
	onDismiss: () => void;
	className?: string;
}) {
	const dates = dateParserFor(getLocale()) != null;
	const tokens = syntaxTokens(
		dates ? m.quickadd_example_date() : null,
		m.syntax_hint_word(),
	);
	return (
		<div
			data-testid="syntax-hint"
			role="note"
			aria-label={m.syntax_hint_title()}
			className={cn(
				"flex items-start gap-1 text-xs text-muted-foreground",
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1.5">
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					{lead}
					{tokens.map((t) => (
						<span key={t.type} className="inline-flex items-center gap-1.5">
							<code
								dir="auto"
								className="rounded-sm bg-muted px-1 py-px font-mono text-foreground"
							>
								{t.token}
							</code>
							{MEANING[t.type]()}
						</span>
					))}
				</p>
				{example && (
					<p data-testid="syntax-hint-example">
						{dates
							? m.syntax_hint_example({
									date: m.quickadd_example_date(),
									priority: "p1",
								})
							: m.syntax_hint_example_nodate({ priority: "p1" })}
					</p>
				)}
			</div>
			<button
				type="button"
				data-testid="syntax-hint-dismiss"
				aria-label={m.syntax_hint_dismiss()}
				onClick={onDismiss}
				className="flex size-11 shrink-0 items-center justify-center rounded-md transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none md:size-7"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}
