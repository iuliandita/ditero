import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "io.ditero.app",
	appName: "Ditero",
	webDir: "dist",
	plugins: {
		CapacitorHttp: { enabled: false },
		CapacitorCookies: { enabled: false },
	},
};
export default config;
