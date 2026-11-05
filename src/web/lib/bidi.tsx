import { Fragment, type ReactNode } from "react";
import { getLocale } from "../../paraglide/runtime.js";

const SLOT = "";

/**
 * Render a translated message with `value` isolated in a <bdi>. The text
 * content is unchanged, so only the interpolated value (not the sentence)
 * gets its own direction.
 */
export function isolated(
	message: (value: string) => string,
	value: string,
): ReactNode {
	const parts = message(SLOT).split(SLOT);
	return parts.map((part, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length split of one message
		<Fragment key={i}>
			{part}
			{i < parts.length - 1 && <bdi>{value}</bdi>}
		</Fragment>
	));
}

/**
 * Locale-aware name list with each name isolated. The locale's own separators
 * and conjunction stay outside the <bdi>, so Arabic reads "Alex Reed، Casey Lane".
 */
export function NameList({
	names,
	type = "conjunction",
}: {
	names: string[];
	type?: Intl.ListFormatType;
}) {
	const parts = new Intl.ListFormat(getLocale(), {
		style: "long",
		type,
	}).formatToParts(names);
	return parts.map((part, i) =>
		part.type === "element" ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
			<bdi key={i}>{part.value}</bdi>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
			<Fragment key={i}>{part.value}</Fragment>
		),
	);
}
