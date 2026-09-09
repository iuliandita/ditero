import assert from "node:assert/strict";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

const zeroManifest = new URL(
	"./node_modules/@rocicorp/zero/package.json",
	import.meta.url,
);
assert.equal(JSON.parse(readFileSync(zeroManifest, "utf8")).version, "1.9.0");
const requireZero = createRequire(realpathSync(zeroManifest));
assert.equal(requireZero("fastify/package.json").version, "5.12.3");

// Check physical packages too, so an unused vulnerable copy cannot survive.
const modules = new URL("./node_modules/", import.meta.url);
for (const path of readdirSync(modules, { recursive: true })) {
	if (path.endsWith("/fastify/package.json")) {
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"5.12.3",
		);
	}
}

const Database = requireZero("@rocicorp/zero-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("select 1 as value").get().value, 1);
db.close();
console.log(
	`Zero 1.9.0, Fastify 5.12.3, SQLite ${process.platform}/${process.arch} verified`,
);
