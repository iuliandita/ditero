import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select.tsx";
import {
	type SettingsSectionId,
	settingsSectionDomId,
} from "./SettingsSection.tsx";

export type SettingsNavItem = { id: SettingsSectionId; label: string };

// Jumps to a section and moves focus to its heading, so keyboard and screen
// reader users land where sighted users do.
export function jumpToSettingsSection(id: SettingsSectionId) {
	const section = document.getElementById(settingsSectionDomId(id));
	if (!section) return;
	section.scrollIntoView({
		behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? "auto"
			: "smooth",
		block: "start",
	});
	document
		.getElementById(`${settingsSectionDomId(id)}-heading`)
		?.focus({ preventScroll: true });
}

// The section index stays available as a compact selector on narrow screens.
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
	const [current, setCurrent] = useState<SettingsSectionId | null>(
		items[0]?.id ?? null,
	);

	const selectedSection = useRef<SettingsSectionId | null>(null);
	const navRef = useRef<HTMLElement>(null);

	useEffect(() => {
		const visible = new Map<SettingsSectionId, number>();
		const sections = items.flatMap((item) => {
			const element = document.getElementById(settingsSectionDomId(item.id));
			return element ? [element] : [];
		});
		let observer: IntersectionObserver | undefined;
		let boundary: number | undefined;
		const observeSections = () => {
			if (!sections[0]) return;
			// Exclude the preceding section's edge at the scroll landing point.
			const nextBoundary =
				Math.ceil(
					Number.parseFloat(getComputedStyle(sections[0]).scrollMarginTop),
				) + 1;
			if (nextBoundary === boundary) return;
			boundary = nextBoundary;
			observer?.disconnect();
			visible.clear();
			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						const id = (entry.target as HTMLElement).dataset.section as
							| SettingsSectionId
							| undefined;
						if (!id) continue;
						if (entry.isIntersecting)
							visible.set(id, entry.boundingClientRect.top);
						else visible.delete(id);
					}
					const last = items.at(-1);
					const lastSection =
						last && document.getElementById(settingsSectionDomId(last.id));
					// A short final section cannot scroll to the top of the viewport.
					if (
						lastSection &&
						lastSection.getBoundingClientRect().bottom <= window.innerHeight
					) {
						setCurrent(last.id);
						return;
					}
					const first = items.find((item) => visible.has(item.id));
					if (first) setCurrent(first.id);
				},
				{ rootMargin: `-${boundary}px 0px -60% 0px` },
			);
			for (const section of sections) observer.observe(section);
		};
		observeSections();
		const resizeObserver = new ResizeObserver(observeSections);
		if (navRef.current) resizeObserver.observe(navRef.current);
		if (sections[0]) resizeObserver.observe(sections[0]);
		return () => {
			observer?.disconnect();
			resizeObserver.disconnect();
		};
	}, [items]);

	return (
		<nav
			ref={navRef}
			aria-label={m.settings_nav_label()}
			data-testid="settings-nav"
			className="sticky top-0 z-10 mb-6 max-w-2xl self-start bg-background py-2 xl:top-6 xl:mb-0 xl:py-0"
		>
			<div className="xl:hidden">
				<Select
					value={current ?? undefined}
					dir={getLocale() === "ar" ? "rtl" : "ltr"}
					onValueChange={(id) => {
						const section = items.find((item) => item.id === id);
						if (!section) return;
						setCurrent(section.id);
						selectedSection.current = section.id;
					}}
				>
					<SelectTrigger
						aria-label={m.settings_nav_label()}
						data-testid="settings-section-select"
						className="min-h-11 w-full motion-reduce:transition-none"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent
						position="popper"
						className="motion-reduce:animate-none"
						onCloseAutoFocus={(event) => {
							const id = selectedSection.current;
							if (!id) return;
							event.preventDefault();
							selectedSection.current = null;
							jumpToSettingsSection(id);
						}}
					>
						{items.map((item) => (
							<SelectItem key={item.id} value={item.id} className="min-h-11">
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<ul className="hidden flex-col gap-0.5 xl:flex">
				{items.map((item) => (
					<li key={item.id}>
						<a
							href={`#${settingsSectionDomId(item.id)}`}
							aria-current={current === item.id ? "location" : undefined}
							className={cn(
								"block rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
								current === item.id && "font-medium text-foreground",
							)}
							onClick={(event) => {
								// The URL fragment is reserved for invite secrets; never write
								// a section id into it.
								event.preventDefault();
								setCurrent(item.id);
								jumpToSettingsSection(item.id);
							}}
						>
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
