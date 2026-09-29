import { m } from "../../../paraglide/messages.js";
import { useHints } from "../../hooks/useHints.ts";
import { formatBinding } from "../../keyboard/binding-label.ts";
import { useEffectiveKeymap } from "../../keyboard/useEffectiveKeymap.ts";
import { syntaxHintVisible } from "../../lib/hints.ts";
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
	if (!syntaxHintVisible(hints)) return null;
	const keyLabel = binding ? formatBinding(binding) : null;
	return (
		<SyntaxHint
			example={example}
			onDismiss={dismissSyntax}
			lead={
				<button
					type="button"
					data-testid="syntax-hint-open-quickadd"
					onClick={onQuickAdd}
					className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
