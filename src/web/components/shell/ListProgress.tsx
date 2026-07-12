// Aggregate completion bar for project-kind lists in the index surfaces
// (sidebar tree + mobile list-of-lists). Renders nothing when the list has no
// tasks. done/total counts come from the already-synced tasks.mine data.
export function ListProgress({ done, total }: { done: number; total: number }) {
	if (total === 0) return null;
	const pct = Math.round((done / total) * 100);
	return (
		<div
			className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
			role="progressbar"
			aria-valuenow={pct}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label={`${done} of ${total} complete`}
		>
			<div
				className="h-full rounded-full bg-kind-project"
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}
