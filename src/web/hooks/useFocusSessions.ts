import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { FocusSession } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.focusSessions.mine, optionally filtered client-side
// to one task over the synced set (mirrors how useViews selects synced rows).
export function useFocusSessions(taskId?: string): {
	sessions: FocusSession[];
	loading: boolean;
} {
	const [rows, details] = useQuery(queries.focusSessions.mine());
	const sessions = useMemo<FocusSession[]>(
		() =>
			taskId === undefined ? rows : rows.filter((r) => r.taskId === taskId),
		[rows, taskId],
	);
	return { sessions, loading: details.type !== "complete" };
}
