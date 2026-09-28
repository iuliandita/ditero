import { useEffect, useState } from "react";
import { useIsDesktop } from "./use-media-query.ts";

// Board, table and the month grid need room the viewport alone does not
// promise: the docked task detail takes 384-440px of a desktop viewport. They
// switch on the width their container actually gets. 672px is Tailwind's @2xl
// container size, the same threshold the dashboard grid uses in CSS.
export const WIDE_CONTENT_PX = 672;

export function isWideContent(
	isDesktop: boolean,
	width: number | null,
): boolean {
	// Before the first measurement, trust the viewport rather than flash the
	// collapsed layout on every desktop mount.
	return isDesktop && (width == null || width >= WIDE_CONTENT_PX);
}

export function useWideContent(): [(el: HTMLElement | null) => void, boolean] {
	const isDesktop = useIsDesktop();
	const [el, setEl] = useState<HTMLElement | null>(null);
	const [width, setWidth] = useState<number | null>(null);
	useEffect(() => {
		if (!el) return;
		setWidth(el.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) =>
			setWidth(entry.contentRect.width),
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [el]);
	return [setEl, isWideContent(isDesktop, width)];
}
