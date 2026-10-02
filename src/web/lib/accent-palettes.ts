export const ACCENT_PALETTES = {
	teal: {
		main: "#1F8A7A",
		light: {
			accent: "#17695D",
			soft: "#E3F2EF",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#3FB4A0",
			soft: "#1B3532",
			buttonInk: "#0F1A18",
		},
	},
	blue: {
		main: "#3B73C9",
		light: {
			accent: "#2559A8",
			soft: "#E6EEFA",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#6FA0F0",
			soft: "#1B2A44",
			buttonInk: "#0C1424",
		},
	},
	clay: {
		main: "#C75B3F",
		light: {
			accent: "#A64428",
			soft: "#FAEAE4",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#E88A6C",
			soft: "#3A2119",
			buttonInk: "#1F0F0A",
		},
	},
	violet: {
		main: "#8061D0",
		light: {
			accent: "#6144B5",
			soft: "#EFEBFA",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#A590F0",
			soft: "#2A2347",
			buttonInk: "#140F29",
		},
	},
	berry: {
		main: "#C2457A",
		light: {
			accent: "#A32D63",
			soft: "#FAE8F0",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#EE7FA9",
			soft: "#3C1A2B",
			buttonInk: "#2A0E1B",
		},
	},
	ochre: {
		main: "#A87A0C",
		light: {
			accent: "#7F5A00",
			soft: "#F7EFD9",
			buttonInk: "#FFFFFF",
		},
		dark: {
			accent: "#D0A030",
			soft: "#352B12",
			buttonInk: "#1F1700",
		},
	},
} as const;

export type AccentTheme = keyof typeof ACCENT_PALETTES;
