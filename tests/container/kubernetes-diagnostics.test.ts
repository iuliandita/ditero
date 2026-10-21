import { expect, test } from "vitest";
import { capture } from "./kubernetes-diagnostics.mjs";

test.each([
	"stdout",
	"stderr",
])("bounds %s while the child is still producing output", async (stream) => {
	const result = await capture(
		process.execPath,
		["-e", `setInterval(() => process.${stream}.write('x'.repeat(65536)), 1)`],
		{ limit: 1024, timeout: 2000 },
	);
	expect(result.output.length).toBe(1024);
	expect(result.truncated).toBe(true);
	expect(result.timedOut).toBe(false);
	expect(result.signal).toBe("SIGKILL");
});

test("terminates a silent hung child and retains an ordinary failed exit", async () => {
	const hung = await capture(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{
			timeout: 100,
		},
	);
	expect(hung.timedOut).toBe(true);
	expect(hung.output.length).toBe(0);
	const failed = await capture(process.execPath, [
		"-e",
		"console.error('refused'); process.exit(7)",
	]);
	expect(failed.code).toBe(7);
	expect(failed.output.toString()).toBe("refused\n");
	expect(failed.truncated).toBe(false);
});
