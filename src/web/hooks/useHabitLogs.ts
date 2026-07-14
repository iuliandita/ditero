import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { HabitLog } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.habitLogs.mine, filtered client-side to one habit
// over the synced set (mirrors how useViews selects from the synced rows).
export function useHabitLogs(habitId: string): {
	logs: HabitLog[];
	loading: boolean;
} {
	const [rows, details] = useQuery(queries.habitLogs.mine());
	const logs = useMemo<HabitLog[]>(
		() => rows.filter((r) => r.habitId === habitId),
		[rows, habitId],
	);
	return { logs, loading: details.type !== "complete" };
}
