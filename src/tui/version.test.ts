import { expect, test, vi } from "vitest";
import release from "../../release.json";
import { MINIMUM_BUN } from "../clients/build-info.ts";
import { runTerminal } from "./index.ts";

test("prints build identity before credentials, locale discovery, or terminal setup", async () => {
	const write = vi
		.spyOn(process.stdout, "write")
		.mockImplementation(() => true);
	try {
		expect(await runTerminal(["--version"], { TERM: "dumb" })).toBe(0);
		expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
			name: "ditero-tui",
			version: release.version,
			commit: "development",
			minimumBun: MINIMUM_BUN,
		});
	} finally {
		write.mockRestore();
	}
});
