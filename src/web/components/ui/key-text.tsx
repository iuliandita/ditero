const SLOT = "\u0000";

// Splits a translated sentence around its {key} placeholder so the key can be
// drawn as a keycap while translators still control word order.
export function splitAroundKey(
	render: (key: string) => string,
): [string, string] {
	const [before, after = ""] = render(SLOT).split(SLOT);
	return [before, after];
}

export function KeyText({
	render,
	keyLabel,
}: {
	render: (key: string) => string;
	keyLabel: string;
}) {
	const [before, after] = splitAroundKey(render);
	return (
		<>
			{before}
			<kbd className="rounded border bg-background px-1 font-mono text-[0.6875rem] text-foreground">
				{keyLabel}
			</kbd>
			{after}
		</>
	);
}
