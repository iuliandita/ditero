import { useEffect, useState, useSyncExternalStore } from "react";
import { useIsDesktop } from "./use-media-query.ts";

// Board, table, month grid and the 12-column dashboard are desktop layouts from
// md, as they always were. Only while the docked task detail is open (it takes
// 384-440px of the viewport) do they check the width they actually get, and
// fall back to the stacked layout below 672px (Tailwind's @2xl container).
export const WIDE_CONTENT_PX = 672;

let openPanels = 0;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

/** Called by the docked TaskDetail while mounted; returns the release. */
export function markTaskPanelOpen(): () => void {
	openPanels += 1;
	emit();
	return () => {
		openPanels -= 1;
		emit();
	};
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useTaskPanelOpen(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => openPanels > 0,
		() => false,
	);
}

export function isWideContent(
	isDesktop: boolean,
	panelOpen: boolean,
	width: number | null,
): boolean {
	if (!isDesktop) return false;
	if (!panelOpen) return true;
	return width != null && width >= WIDE_CONTENT_PX;
}

export function useWideContent(): [(el: HTMLElement | null) => void, boolean] {
	const isDesktop = useIsDesktop();
	const panelOpen = useTaskPanelOpen();
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
	return [setEl, isWideContent(isDesktop, panelOpen, width)];
}
