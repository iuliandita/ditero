import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import type { Panel } from "../../domain/dashboard.ts";
import { randomId } from "../../domain/random-id.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { Dashboard, Membership, schema } from "../../zero/schema.gen.ts";
import type { DashboardFormValue } from "../components/dashboard/DashboardManager.tsx";
import { useConfirm } from "../components/ui/confirm.tsx";
import { dashboardHomeRef } from "../views/home-ref.ts";
import type { UserPrefState } from "./useUserPref.ts";

// The dashboard wiring: the edit gate the surface mirrors, and the dashboard
// mutations only this surface reaches.
export function useWorkspaceDashboards({
	dashboards,
	openDashboardRow,
	memberships,
	pref,
	setPref,
	dashboardManager,
	setDashboardManager,
	onCloseDashboard,
	openDashboard,
}: {
	dashboards: Dashboard[];
	openDashboardRow: Dashboard | null;
	memberships: Membership[];
	pref: UserPrefState;
	setPref: (patch: Partial<UserPrefState>) => void;
	dashboardManager: { mode: "create" } | { mode: "edit"; id: string } | null;
	setDashboardManager: (
		next: { mode: "create" } | { mode: "edit"; id: string } | null,
	) => void;
	onCloseDashboard: (id: string) => void;
	openDashboard: (id: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();

	// Mirrors requireDashboardEdit in the mutators: personal -> owner only,
	// workspace -> role in the write set. The server re-checks on write.
	const canEditDashboard = useMemo(() => {
		if (!openDashboardRow) return false;
		if (openDashboardRow.scope === "personal")
			return openDashboardRow.ownerId === zero.userID;
		return memberships.some(
			(row) =>
				row.userId === zero.userID &&
				row.workspaceId === openDashboardRow.workspaceId &&
				(row.role === "owner" || row.role === "admin" || row.role === "member"),
		);
	}, [openDashboardRow, memberships, zero.userID]);

	function updateDashboardPanels(id: string, panels: Panel[]) {
		void zero
			.mutate(
				mutators.dashboard.update({
					id,
					panels: panels as ReadonlyJSONValue,
				}),
			)
			.client.catch((e) => console.error("dashboard.update failed", e));
	}

	async function deleteDashboard(dashboard: Dashboard) {
		const id = dashboard.id;
		const ok = await confirm({
			title: m.dashboard_delete_title(),
			body: m.dashboard_delete_confirm({ name: dashboard.name }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.dashboard.delete({ id }))
			.client.catch((e) => console.error("dashboard.delete failed", e));
		// Mirror deleteView: never leave the home ref dangling.
		if (pref.homeViewRef === dashboardHomeRef(id))
			setPref({ homeViewRef: null });
		onCloseDashboard(id);
	}

	function submitDashboard(value: DashboardFormValue) {
		if (dashboardManager?.mode === "edit") {
			void zero
				.mutate(
					mutators.dashboard.update({
						id: dashboardManager.id,
						name: value.name,
						icon: value.icon,
					}),
				)
				.client.catch((e) => console.error("dashboard.update failed", e));
		} else {
			const id = randomId();
			const lastKey = dashboards.at(-1)?.sortKey ?? null;
			void zero
				.mutate(
					mutators.dashboard.create({
						id,
						name: value.name,
						...(value.icon != null ? { icon: value.icon } : {}),
						scope: value.scope,
						workspaceId: value.workspaceId,
						panels: [],
						sortKey: keyBetween(lastKey, null),
					}),
				)
				.client.catch((e) => console.error("dashboard.create failed", e));
			openDashboard(id);
		}
		setDashboardManager(null);
	}

	return {
		canEditDashboard,
		updateDashboardPanels,
		deleteDashboard,
		submitDashboard,
	};
}
