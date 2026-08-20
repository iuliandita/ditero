// The harness in crypto-vectors.ts is an unwrapping oracle over the user's key
// material for anything running in the page. It is guarded by two compile-time
// constants, and a guard that fails to eliminate is invisible: dev, test and
// every unit test stay green either way. So the real production bundle is built
// and searched for the marker.
//
// The development build is asserted too, and it is not decoration: the absence
// assertion passes for free the day the guard stops compiling at all, or the
// entry stops importing the harness. It is the proof this test can fail.
//
// Built by spawning the same command the image builds with (deploy/docker/
// Dockerfile: `bunx vite build`) rather than through vite's JS API. The API
// build sets process.env.NODE_ENV for the whole process, and vite derives
// `import.meta.env.DEV` from NODE_ENV ahead of `mode` -- so under vitest, whose
// NODE_ENV is "test", an in-process production build keeps DEV true and the
// guard never eliminates. That is a property of the test harness, not of the
// shipped bundle.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const MARKER = "__diteroCrypto";

function bundle(mode: "production" | "development"): string {
	const out = mkdtempSync(path.join(tmpdir(), `ditero-bundle-${mode}-`));
	try {
		const env = { ...process.env, NODE_ENV: mode };
		execFileSync(
			"bunx",
			["vite", "build", "--mode", mode, "--outDir", out, "--emptyOutDir"],
			{ cwd: root, env, stdio: "pipe" },
		);
		return readdirSync(out, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => readFileSync(path.join(entry.parentPath, entry.name)))
			.join("\n");
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

test("the development bundle carries the crypto harness", {
	timeout: 300_000,
}, () => {
	expect(bundle("development")).toContain(MARKER);
});

test("the production bundle does not carry the crypto harness", {
	timeout: 300_000,
}, () => {
	expect(bundle("production")).not.toContain(MARKER);
});
