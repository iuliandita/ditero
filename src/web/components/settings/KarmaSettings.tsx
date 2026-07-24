import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";

// Karma goals + vacation editor (shell doc 5). Goal inputs cap at the mutator's
// 0..1000; useUserPref.setPref re-clamps every write. Vacation carries an
// optional "until" date and an honesty note. 0 means "unset" (no goal ring
// target), which the panel renders as an unset affordance rather than dividing
// by zero. `label` is a getter: this array is module-level, so resolving the
// message eagerly would freeze it at the import-time locale.
const GOAL_FIELDS: {
	key: "daily" | "weekly";
	label: string;
	testid: string;
}[] = [
	{
		key: "daily",
		get label() {
			return m.karma_goal_daily();
		},
		testid: "karma-goal-daily-input",
	},
	{
		key: "weekly",
		get label() {
			return m.karma_goal_weekly();
		},
		testid: "karma-goal-weekly-input",
	},
];

export function KarmaSettings() {
	const { pref, setPref } = useUserPref();
	const goals = pref.karmaGoals;
	const vacation = pref.vacation;

	return (
		<section
			className="mt-8 border-t pt-4"
			aria-labelledby="karma-settings-heading"
			data-testid="karma-settings"
		>
			<h2 id="karma-settings-heading" className="text-sm font-semibold">
				{m.karma_goals_heading()}
			</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				{m.karma_goals_description()}
			</p>

			<div className="mt-4 grid grid-cols-2 gap-3">
				{GOAL_FIELDS.map((f) => (
					<label key={f.key} className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{f.label}</span>
						<input
							type="number"
							min={0}
							max={1000}
							value={goals[f.key]}
							data-testid={f.testid}
							className="h-8 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) =>
								setPref({
									karmaGoals: { ...goals, [f.key]: e.target.valueAsNumber },
								})
							}
						/>
					</label>
				))}
			</div>

			<div className="mt-6 flex items-center justify-between gap-4">
				<span className="flex flex-col">
					<span className="text-sm">{m.karma_vacation_label()}</span>
					<span className="text-xs text-muted-foreground">
						{m.karma_vacation_note()}
					</span>
				</span>
				<Button
					size="sm"
					variant={vacation.active ? "default" : "outline"}
					role="switch"
					aria-checked={vacation.active}
					aria-label={m.karma_vacation_label()}
					data-testid="karma-vacation-toggle"
					onClick={() =>
						setPref({ vacation: { ...vacation, active: !vacation.active } })
					}
				>
					{vacation.active ? m.toggle_on() : m.toggle_off()}
				</Button>
			</div>

			{vacation.active && (
				<label className="mt-3 flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">
						{m.karma_vacation_until()}
					</span>
					<input
						type="date"
						value={vacation.until ?? ""}
						data-testid="karma-vacation-until"
						className="h-8 w-fit rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) => {
							const until = e.target.value;
							setPref({
								vacation: until ? { active: true, until } : { active: true },
							});
						}}
					/>
				</label>
			)}
		</section>
	);
}
