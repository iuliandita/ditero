import { useEffect, useId, useRef, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import { getLocale, setLocale } from "../../../paraglide/runtime.js";
import {
	createLocaleChangeAction,
	localeOptions,
} from "../../lib/language-switcher.ts";
import { applyDocumentLocale, type Locale } from "../../lib/locale.ts";
import { captureZeroClientOwner } from "../../lib/zero-lifecycle.ts";
import { Button } from "../ui/button.tsx";
import { useSnackbar } from "../ui/snackbar.tsx";

// Mounted both pre-auth (Login) and post-auth (settings). `persistLocale` is
// only supplied post-auth, where a Zero client exists to write
// `user_pref.locale`; its absence is exactly "not authed" for this switcher.
export function LanguageSwitcher({
	persistLocale,
	compact = false,
}: {
	persistLocale?: (locale: Locale) => Promise<boolean>;
	compact?: boolean;
}) {
	const [value, setValue] = useState<Locale>(getLocale() as Locale);
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	const pendingRef = useRef(false);
	const mounted = useRef(true);
	const { show } = useSnackbar();
	const choice = useRef<ReturnType<typeof createLocaleChangeAction> | null>(
		null,
	);
	const labelId = useId();
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	function onChange(next: string) {
		if (pendingRef.current) return;
		choice.current = createLocaleChangeAction(next as Locale, {
			setLocale,
			applyDocumentLocale,
			persistLocale,
			isOwnerActive: captureZeroClientOwner() ?? (() => mounted.current),
			isChildMounted: () => mounted.current,
			onPending: (busy) => {
				pendingRef.current = busy;
				setPending(busy);
				if (busy) setFailed(false);
			},
			onApplied: setValue,
			onInlineError: () => setFailed(true),
			onGlobalError: (retry) =>
				show({
					message: m.sync_save_pending_failed(),
					action: { label: m.action_retry(), run: retry },
				}),
		});
		void choice.current.run();
	}

	return (
		<div
			className={
				compact
					? "flex flex-col items-start gap-2 text-sm"
					: "flex flex-col gap-1 text-sm"
			}
		>
			<span
				id={labelId}
				className={compact ? "sr-only" : "text-muted-foreground"}
			>
				{m.language_switcher_label()}
			</span>
			<Select
				value={value}
				onValueChange={onChange}
				disabled={pending || failed}
			>
				<SelectTrigger
					aria-labelledby={labelId}
					data-testid="language-switcher"
					className={
						compact
							? "w-auto min-w-36 border-0 bg-transparent text-muted-foreground shadow-none data-[size=default]:h-11 hover:text-foreground dark:bg-transparent"
							: "w-full sm:w-56 pointer-coarse:data-[size=default]:h-11"
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
			{failed && (
				<div className="flex flex-col items-start gap-2">
					<p role="alert">{m.sync_save_pending_failed()}</p>
					<Button disabled={pending} onClick={() => void choice.current?.run()}>
						{m.action_retry()}
					</Button>
				</div>
			)}
		</div>
	);
}
