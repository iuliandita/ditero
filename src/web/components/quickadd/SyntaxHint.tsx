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
export function SyntaxHint() {
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
			className="text-xs text-muted-foreground"
		>
			<details className="min-w-0">
				<summary
					data-testid="syntax-hint-details"
					className="min-h-11 cursor-pointer content-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-7"
				>
					{m.quickadd_shortcuts()}
				</summary>
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
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
			</details>
		</div>
	);
}
