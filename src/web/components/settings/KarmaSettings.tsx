import { Button } from "@/components/ui/button";
import { useUserPref } from "../../hooks/useUserPref.ts";

// Karma goals + vacation editor (shell doc 5). Goal inputs cap at the mutator's
// 0..1000; useUserPref.setPref re-clamps every write. Vacation carries an
// optional "until" date and an honesty note. 0 means "unset" (no goal ring
// target), which the panel renders as an unset affordance rather than dividing
// by zero.
const GOAL_FIELDS: {
	key: "daily" | "weekly";
	label: string;
	testid: string;
}[] = [
	{ key: "daily", label: "Daily goal", testid: "karma-goal-daily-input" },
	{ key: "weekly", label: "Weekly goal", testid: "karma-goal-weekly-input" },
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
				Karma goals
			</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				Daily and weekly completion targets. Set to 0 to disable a goal.
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
					<span className="text-sm">Vacation mode</span>
					<span className="text-xs text-muted-foreground">
						Pauses streak breaks and goal penalties. A pause, not a cheat.
					</span>
				</span>
				<Button
					size="sm"
					variant={vacation.active ? "default" : "outline"}
					role="switch"
					aria-checked={vacation.active}
					aria-label="Vacation mode"
					data-testid="karma-vacation-toggle"
					onClick={() =>
						setPref({ vacation: { ...vacation, active: !vacation.active } })
					}
				>
					{vacation.active ? "On" : "Off"}
				</Button>
			</div>

			{vacation.active && (
				<label className="mt-3 flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">Until (optional)</span>
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
