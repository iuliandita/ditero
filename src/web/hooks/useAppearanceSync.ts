import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import {
	type Appearance,
	validateAppearance,
} from "../../domain/appearance.ts";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import type { AppearanceMutation } from "../lib/appearance-save.ts";
import { isZeroClientOwnerActive } from "../lib/zero-lifecycle.ts";

export type AppearanceSync = {
	loading: boolean;
	appearance: Appearance | null;
	mutate: (appearance: Appearance) => AppearanceMutation;
	isActive: () => boolean;
};

export function useAppearanceSync(): AppearanceSync {
	const zero = useZero<typeof schema>();
	const [rows, details] = useQuery(queries.userPrefs.mine());
	const value = rows[0]?.appearance;
	const appearance = useMemo(
		() => (value == null ? null : validateAppearance(value)),
		[value],
	);
	return {
		loading: details.type !== "complete",
		appearance,
		mutate: (next) =>
			zero.mutate(
				mutators.userPref.set({ appearance: validateAppearance(next) }),
			),
		isActive: () => isZeroClientOwnerActive(zero),
	};
}
