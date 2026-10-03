import { expect, test, vi } from "vitest";
import release from "../../release.json";
import { runTerminal } from "./index.ts";

test("prints build identity before credentials, locale discovery, or terminal setup", async () => {
	const write = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(() => true);
	try {
		expect(await runTerminal(["--version"], { TERM: "dumb" })).toBe(0);
		expect(write).toHaveBeenCalledWith(
			`ditero-tui ${release.version} (development+modified; source)\n`,
		);
	} finally {
		write.mockRestore();
	}
});
