import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
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

// Desktop-only table of contents. The surface is long, and the order alone
// (danger zone last) does not help someone looking for Notifications.
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
	const [current, setCurrent] = useState<SettingsSectionId | null>(
		items[0]?.id ?? null,
	);

	useEffect(() => {
		const visible = new Map<SettingsSectionId, number>();
		const observer = new IntersectionObserver(
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
				const first = items.find((item) => visible.has(item.id));
				if (first) setCurrent(first.id);
			},
			{ rootMargin: "0px 0px -60% 0px" },
		);
		for (const item of items) {
			const el = document.getElementById(settingsSectionDomId(item.id));
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	}, [items]);

	return (
		<nav aria-label={m.settings_nav_label()} data-testid="settings-nav">
			<ul className="flex flex-col gap-0.5">
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
