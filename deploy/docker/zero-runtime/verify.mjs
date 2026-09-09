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

const cloudeventsManifest = requireZero.resolve("cloudevents/package.json");
const requireCloudEvents = createRequire(realpathSync(cloudeventsManifest));
assert.equal(requireCloudEvents("uuid/package.json").version, "11.1.1");
const { CloudEvent } = requireCloudEvents("cloudevents");
assert.match(
	new CloudEvent({ source: "/test", type: "test" }).id,
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const uuid = requireCloudEvents("uuid");
assert.throws(
	() => uuid.v5("x", uuid.v5.DNS, new Uint8Array(8), 4),
	RangeError,
);

// Check physical packages too, so an unused vulnerable copy cannot survive.
const modules = new URL("./node_modules/", import.meta.url);
for (const path of readdirSync(modules, { recursive: true })) {
	if (path.endsWith("/fastify/package.json")) {
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"5.12.3",
		);
	}
	if (path === "uuid/package.json" || path.endsWith("/uuid/package.json")) {
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"11.1.1",
		);
	}
}

const Database = requireZero("@rocicorp/zero-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("select 1 as value").get().value, 1);
db.close();
console.log(
	`Zero 1.9.0, Fastify 5.12.3, UUID 11.1.1, SQLite ${process.platform}/${process.arch} verified`,
);
