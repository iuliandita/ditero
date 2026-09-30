import { m } from "../../../paraglide/messages.js";
import { useHints } from "../../hooks/useHints.ts";
import { formatBinding } from "../../keyboard/binding-label.ts";
import { useEffectiveKeymap } from "../../keyboard/useEffectiveKeymap.ts";
import { syntaxHintVisible } from "../../lib/hints.ts";
import { useMediaQuery } from "../../lib/use-media-query.ts";
import { KeyText } from "../ui/key-text.tsx";
import { SyntaxHint } from "./SyntaxHint.tsx";

// The list's own add field takes titles verbatim; the grammar belongs to quick
// add. So this hint points there rather than promising tokens this field would
// store as literal text.
export function InlineSyntaxHint({
	example,
	onQuickAdd,
}: {
	example: boolean;
	onQuickAdd: () => void;
}) {
	const { hints, dismissSyntax } = useHints();
	const binding = useEffectiveKeymap()["task.create"]?.[0];
	// A keycap means nothing without a keyboard; touch gets the plain lead.
	const finePointer = useMediaQuery("(any-pointer: fine)");
	if (!syntaxHintVisible(hints)) return null;
	const keyLabel = binding && finePointer ? formatBinding(binding) : null;
	return (
		<SyntaxHint
			example={example}
			collapsible
			introduction={m.syntax_hint_inline_literal()}
			onDismiss={dismissSyntax}
			lead={
				<button
					type="button"
					data-testid="syntax-hint-open-quickadd"
					onClick={onQuickAdd}
					className="inline-flex min-h-11 items-center rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:min-h-7"
				>
					{keyLabel ? (
						<KeyText
							render={(key) => m.syntax_hint_inline_lead({ key })}
							keyLabel={keyLabel}
						/>
					) : (
						m.syntax_hint_inline_lead_nokey()
					)}
				</button>
			}
		/>
	);
}
