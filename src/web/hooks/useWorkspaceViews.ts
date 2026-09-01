import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { randomId } from "../../domain/random-id.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import type { FilterGroup, ViewDisplay } from "../../domain/view-filter.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { useConfirm } from "../components/ui/confirm.tsx";
import type { ViewFormValue } from "../components/views/ViewManager.tsx";
import { type BuiltinViewId, getBuiltin } from "../views/builtins.ts";
import type { UserPrefState } from "./useUserPref.ts";
import type { SavedView } from "./useViews.ts";

// Resolved view descriptor: a built-in aggregate or a saved row, unified for the
// renderer/header. `saved` is set only for editable saved views.
export type ResolvedView = {
	id: string;
	name: string;
	icon: string | null;
	filter: FilterGroup;
	display: ViewDisplay;
	saved: SavedView | null;
};

// The saved-view wiring: pin/home prefs, the built-in|saved resolution the
// header and renderer share, and the view mutations only this surface reaches.
export function useWorkspaceViews({
	savedViews,
	pref,
	setPref,
	viewManager,
	setViewManager,
	onCloseView,
	openView,
}: {
	savedViews: SavedView[];
	pref: UserPrefState;
	setPref: (patch: Partial<UserPrefState>) => void;
	viewManager: { mode: "create" } | { mode: "edit"; id: string } | null;
	setViewManager: (
		next: { mode: "create" } | { mode: "edit"; id: string } | null,
	) => void;
	onCloseView: (id: string) => void;
	openView: (id: string) => void;
}) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();

	const pinnedViews = useMemo(() => {
		const set = new Set(pref.pinnedViews);
		return savedViews
			.filter((v) => set.has(v.id))
			.sort((a, b) =>
				a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
			);
	}, [savedViews, pref.pinnedViews]);

	function resolveView(id: string): ResolvedView | null {
		const b = getBuiltin(id as BuiltinViewId);
		if (b)
			return {
				id,
				name: b.name,
				icon: b.icon,
				filter: b.filter,
				display: b.display,
				saved: null,
			};
		const s = savedViews.find((v) => v.id === id);
		if (s)
			return {
				id,
				name: s.name,
				icon: s.icon ?? null,
				filter: s.filter,
				display: s.display,
				saved: s,
			};
		return null;
	}

	const isPinned = (id: string) => pref.pinnedViews.includes(id);
	function togglePin(id: string) {
		setPref({
			pinnedViews: isPinned(id)
				? pref.pinnedViews.filter((v) => v !== id)
				: [...pref.pinnedViews, id],
		});
	}
	function setHome(id: string) {
		setPref({ homeViewRef: id });
	}
	async function deleteView(view: SavedView) {
		const id = view.id;
		const ok = await confirm({
			title: m.view_delete_title(),
			body: m.view_delete_confirm({ name: view.name }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.view.delete({ id }))
			.client.catch((e) => console.error("view.delete failed", e));
		// Drop it from pins, and fall the home ref back to the default if it pointed
		// here (both are one pref write when both apply).
		const patch: Parameters<typeof setPref>[0] = {};
		if (isPinned(id))
			patch.pinnedViews = pref.pinnedViews.filter((v) => v !== id);
		if (pref.homeViewRef === id) patch.homeViewRef = null;
		if (Object.keys(patch).length) setPref(patch);
		onCloseView(id);
	}

	function submitView(value: ViewFormValue) {
		if (viewManager?.mode === "edit") {
			void zero
				.mutate(
					mutators.view.update({
						id: viewManager.id,
						name: value.name,
						icon: value.icon,
						filter: value.filter as ReadonlyJSONValue,
						display: value.display as ReadonlyJSONValue,
					}),
				)
				.client.catch((e) => console.error("view.update failed", e));
		} else {
			const id = randomId();
			const lastKey = pinnedViews.reduce<string | null>(
				(max, v) => (max == null || v.sortKey > max ? v.sortKey : max),
				null,
			);
			void zero
				.mutate(
					mutators.view.create({
						id,
						name: value.name,
						...(value.icon != null ? { icon: value.icon } : {}),
						scope: value.scope,
						workspaceId: value.workspaceId,
						filter: value.filter as ReadonlyJSONValue,
						display: value.display as ReadonlyJSONValue,
						sortKey: keyBetween(lastKey, null),
					}),
				)
				.client.catch((e) => console.error("view.create failed", e));
			// Pin so it appears in the sidebar, and land on it.
			setPref({ pinnedViews: [...pref.pinnedViews, id] });
			openView(id);
		}
		setViewManager(null);
	}

	return {
		pinnedViews,
		resolveView,
		isPinned,
		togglePin,
		setHome,
		deleteView,
		submitView,
	};
}
