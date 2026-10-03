import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export function vendorLicenses(): Plugin {
	return {
		name: "vendored-style-license",
		apply: "build",
		generateBundle() {
			this.emitFile({
				type: "asset",
				fileName: "licenses/shadcn-tailwind.txt",
				source: readFileSync(
					new URL("../src/web/vendor/shadcn-LICENSE.md", import.meta.url),
				),
			});
		},
	};
}
