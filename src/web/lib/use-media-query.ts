import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() =>
		typeof window === "undefined" ? false : window.matchMedia(query).matches,
	);
	useEffect(() => {
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		onChange();
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

// Single shell breakpoint (Tailwind md). Below = mobile bottom-nav shell,
// at/above = sidebar shell.
export function useIsDesktop(): boolean {
	return useMediaQuery("(min-width: 768px)");
}
