import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Serial file execution is a correctness property here, not a preference, and
// it must not depend on a flag one npm script happens to pass. The integration
// suite shares one database: several files truncate tables globally, and the
// replica rig spawns real servers that drain the WHOLE outbox, not just their
// own fixture. Under vitest's default fileParallelism a plain
// `bunx vitest run tests/integration` would have the rig truncate another
// file's rows mid-test and deliver its notifications.
export default defineConfig({
	// Mirrors vite.config.ts: shadcn components under src/web resolve each other
	// through "@", so importing any of them from a unit test needs the alias.
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) },
	},
	test: { fileParallelism: false },
});
