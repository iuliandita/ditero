import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import {
	maxRepeatsInput,
	REPEAT_EVERY_MIN_MAX,
	REPEATS_MAX,
	repeatEveryMinInput,
} from "../../lib/escalation-input.ts";

// Radix Select reserves "" for "no value", so the empty choice needs a token.
const NONE = "__none";

export type EscalationValues = {
	repeatEveryMin: number | null;
	maxRepeats: number | null;
	fallbackUserId: string | null;
};

// The repeat/stop/fallback trio, shared by Settings (the user's defaults) and
// the task detail (per-task overrides) so both read the same plain words.
export function EscalationFields({
	values,
	people,
	noneLabel,
	repeatPlaceholder,
	maxPlaceholder,
	repeatHelp,
	disabled = false,
	testIds,
	onChange,
}: {
	values: EscalationValues;
	people: { id: string; name: string }[];
	noneLabel: string;
	repeatPlaceholder?: string;
	maxPlaceholder?: string;
	repeatHelp: string;
	disabled?: boolean;
	testIds: { repeat: string; max: string; fallback: string };
	onChange: (patch: Partial<EscalationValues>) => void;
}) {
	const id = useId();
	const ids = {
		repeat: `${id}-repeat`,
		repeatHelp: `${id}-repeat-help`,
		max: `${id}-max`,
		fallback: `${id}-fallback`,
		fallbackHelp: `${id}-fallback-help`,
	};
	// A stored fallback who has since left every shared workspace still shows,
	// rather than the Select going blank.
	const known =
		values.fallbackUserId == null ||
		people.some((p) => p.id === values.fallbackUserId);

	return (
		<div className="flex flex-col gap-4 text-sm">
			<div className="flex flex-col gap-1">
				<label htmlFor={ids.repeat} className="text-muted-foreground">
					{m.escalation_repeat_every()}
				</label>
				<span className="flex items-center gap-2">
					<Input
						id={ids.repeat}
						disabled={disabled}
						type="number"
						inputMode="numeric"
						min={1}
						max={REPEAT_EVERY_MIN_MAX}
						value={values.repeatEveryMin ?? ""}
						placeholder={repeatPlaceholder}
						aria-describedby={ids.repeatHelp}
						data-testid={testIds.repeat}
						className="w-20 tabular-nums pointer-coarse:h-11"
						onChange={(e) =>
							onChange({ repeatEveryMin: repeatEveryMinInput(e.target.value) })
						}
					/>
					<span className="text-muted-foreground">
						{m.escalation_minutes_suffix()}
					</span>
				</span>
				<p id={ids.repeatHelp} className="text-xs text-muted-foreground">
					{repeatHelp}
				</p>
			</div>

			<div className="flex flex-col gap-1">
				<label htmlFor={ids.max} className="text-muted-foreground">
					{m.escalation_max_repeats()}
				</label>
				<span className="flex items-center gap-2">
					<Input
						id={ids.max}
						disabled={disabled}
						type="number"
						inputMode="numeric"
						min={0}
						max={REPEATS_MAX}
						value={values.maxRepeats ?? ""}
						placeholder={maxPlaceholder}
						data-testid={testIds.max}
						className="w-20 tabular-nums pointer-coarse:h-11"
						onChange={(e) =>
							onChange({ maxRepeats: maxRepeatsInput(e.target.value) })
						}
					/>
					<span className="text-muted-foreground">
						{m.escalation_repeats_suffix()}
					</span>
				</span>
			</div>

			<div className="flex flex-col gap-1">
				<span id={ids.fallback} className="text-muted-foreground">
					{m.escalation_fallback_member()}
				</span>
				<Select
					disabled={disabled}
					value={values.fallbackUserId ?? NONE}
					onValueChange={(next) =>
						onChange({ fallbackUserId: next === NONE ? null : next })
					}
				>
					<SelectTrigger
						aria-labelledby={ids.fallback}
						aria-describedby={ids.fallbackHelp}
						data-testid={testIds.fallback}
						className="w-full sm:w-56 pointer-coarse:data-[size=default]:h-11"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value={NONE}>{noneLabel}</SelectItem>
						{people.map((p) => (
							<SelectItem key={p.id} value={p.id}>
								{p.name}
							</SelectItem>
						))}
						{!known && values.fallbackUserId && (
							<SelectItem value={values.fallbackUserId}>
								{m.escalation_fallback_unknown()}
							</SelectItem>
						)}
					</SelectContent>
				</Select>
				<p id={ids.fallbackHelp} className="text-xs text-muted-foreground">
					{m.escalation_fallback_help()}
				</p>
			</div>
		</div>
	);
}
