import { useId, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import { getLocale, setLocale } from "../../../paraglide/runtime.js";
import { changeLocale, localeOptions } from "../../lib/language-switcher.ts";
import { applyDocumentLocale, type Locale } from "../../lib/locale.ts";

// Mounted both pre-auth (Login) and post-auth (settings). `persistLocale` is
// only supplied post-auth, where a Zero client exists to write
// `user_pref.locale`; its absence is exactly "not authed" for this switcher.
export function LanguageSwitcher({
	persistLocale,
	compact = false,
}: {
	persistLocale?: (locale: Locale) => void;
	compact?: boolean;
}) {
	const [value, setValue] = useState<Locale>(getLocale() as Locale);
	const labelId = useId();

	function onChange(next: string) {
		const locale = next as Locale;
		setValue(locale);
		changeLocale(locale, { setLocale, applyDocumentLocale, persistLocale });
	}

	return (
		<div
			className={
				compact ? "flex justify-end text-sm" : "flex flex-col gap-1 text-sm"
			}
		>
			<span
				id={labelId}
				className={compact ? "sr-only" : "text-muted-foreground"}
			>
				{m.language_switcher_label()}
			</span>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger
					aria-labelledby={labelId}
					data-testid="language-switcher"
					className={
						compact
							? "w-auto min-w-36 border-0 bg-transparent text-muted-foreground shadow-none data-[size=default]:h-11 hover:text-foreground dark:bg-transparent"
							: "w-full sm:w-56"
					}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{localeOptions().map((opt) => (
						<SelectItem key={opt.value} value={opt.value}>
							{opt.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
