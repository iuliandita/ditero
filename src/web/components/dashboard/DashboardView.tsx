import type { JSX } from "react";
import type { Dashboard } from "../../../zero/schema.gen.ts";

// Minimal stub: renders the dashboard name; the panel grid lands in the next
// task and replaces this body.
export function DashboardView({
	dashboard,
}: {
	dashboard: Dashboard;
}): JSX.Element {
	return (
		<div data-testid="dashboard-view">
			<h1 className="min-w-0 truncate text-lg font-semibold">
				{dashboard.name}
			</h1>
		</div>
	);
}
