import { useQuery } from "@rocicorp/zero/react";
import { queries } from "../../zero/queries.ts";
import type { Karma, KarmaEvent } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.karma.mine (single row) + queries.karmaEvents.mine
// (the caller's ledger). Selection only; no aggregation.
export function useKarma(): {
	karma: Karma | undefined;
	events: KarmaEvent[];
	loading: boolean;
} {
	const [karmaRows, karmaDetails] = useQuery(queries.karma.mine());
	const [events, eventsDetails] = useQuery(queries.karmaEvents.mine());
	return {
		karma: karmaRows[0],
		events,
		loading:
			karmaDetails.type !== "complete" || eventsDetails.type !== "complete",
	};
}
