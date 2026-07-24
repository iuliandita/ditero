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
}: {
	persistLocale?: (locale: Locale) => void;
}) {
	const [value, setValue] = useState<Locale>(getLocale() as Locale);
	const labelId = useId();

	function onChange(next: string) {
		const locale = next as Locale;
		setValue(locale);
		changeLocale(locale, {
			setLocale,
			applyDocumentLocale,
			persistLocale: persistLocale ?? (() => {}),
			authed: persistLocale != null,
		});
	}

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span id={labelId} className="text-muted-foreground">
				{m.language_switcher_label()}
			</span>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger
					aria-labelledby={labelId}
					data-testid="language-switcher"
					className="w-full sm:w-56"
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
