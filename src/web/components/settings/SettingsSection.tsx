import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SettingsSectionId =
	| "account"
	| "appearance"
	| "notifications"
	| "security"
	| "lists"
	| "focus"
	| "keyboard"
	| "data"
	| "danger";

export const settingsSectionDomId = (id: SettingsSectionId) => `settings-${id}`;

// One settings section: a real heading the section nav can land on, then its
// groups with generous separation. Sections separate with a hairline; groups
// inside a section separate by space alone, so there is never a nested box.
export function SettingsSection({
	id,
	title,
	description,
	tone,
	children,
}: {
	id: SettingsSectionId;
	title: string;
	description?: string;
	tone?: "danger";
	children: ReactNode;
}) {
	const domId = settingsSectionDomId(id);
	return (
		<section
			id={domId}
			data-testid="settings-section"
			data-section={id}
			aria-labelledby={`${domId}-heading`}
			className="scroll-mt-4 border-t py-8 first:border-t-0 first:pt-0 last:pb-0"
		>
			<h2
				id={`${domId}-heading`}
				tabIndex={-1}
				className={cn(
					"text-base font-semibold outline-none",
					tone === "danger" && "text-destructive",
				)}
			>
				{title}
			</h2>
			{description && (
				<p className="mt-1 max-w-prose text-sm text-muted-foreground">
					{description}
				</p>
			)}
			<div className="mt-5 flex flex-col gap-8">{children}</div>
		</section>
	);
}
