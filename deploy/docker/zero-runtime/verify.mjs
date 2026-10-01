import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

assert.equal(process.version, "v22.23.3");
assert.equal(process.versions.undici, "6.28.1");

const zeroManifest = new URL(
	"./node_modules/@rocicorp/zero/package.json",
	import.meta.url,
);
assert.equal(JSON.parse(readFileSync(zeroManifest, "utf8")).version, "1.9.0");
const requireZero = createRequire(realpathSync(zeroManifest));
assert.equal(requireZero("fastify/package.json").version, "5.12.5");
const rimrafManifest = requireZero.resolve("rimraf/package.json");
const requireRimraf = createRequire(realpathSync(rimrafManifest));
assert.deepEqual(
	requireRimraf("glob")
		.globSync("{package.json,pnpm-workspace.yaml}", {
			cwd: new URL(".", import.meta.url),
		})
		.sort(),
	["package.json", "pnpm-workspace.yaml"],
);

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

const ajvManifest = requireCloudEvents.resolve("ajv/package.json");
const requireAjv = createRequire(realpathSync(ajvManifest));
assert.equal(requireAjv("fast-uri/package.json").version, "3.1.8");
assert.equal(
	requireAjv("fast-uri").resolve(
		"https://example.test/schemas/root.json",
		"value.json",
	),
	"https://example.test/schemas/value.json",
);

const requireFastify = createRequire(
	realpathSync(requireZero.resolve("fastify/package.json")),
);
const requireCompiler = createRequire(
	realpathSync(requireFastify.resolve("@fastify/ajv-compiler/package.json")),
);
const requireStringifier = createRequire(
	realpathSync(requireFastify.resolve("fast-json-stringify/package.json")),
);
for (const consumer of [requireCompiler, requireStringifier]) {
	assert.equal(consumer("fast-uri/package.json").version, "4.1.5");
	assert.equal(
		consumer("fast-uri").resolve(
			"https://example.test/schemas/root.json",
			"value.json#/definitions/value",
		),
		"https://example.test/schemas/value.json#/definitions/value",
	);
}

const valueSchema = {
	$id: "https://example.test/schemas/value.json",
	definitions: { value: { type: "integer" } },
};
const rootSchema = {
	$id: "https://example.test/schemas/root.json",
	type: "object",
	properties: { value: { $ref: "value.json#/definitions/value" } },
	required: ["value"],
};
const Ajv = requireCloudEvents("ajv");
const ajv = new Ajv();
ajv.addSchema(valueSchema);
const validate = ajv.compile(rootSchema);
assert.equal(validate({ value: 7 }), true);
assert.equal(validate({ value: "invalid" }), false);

const buildCompiler = requireFastify("@fastify/ajv-compiler")();
const compile = buildCompiler(
	{ [valueSchema.$id]: valueSchema },
	{ customOptions: {} },
);
const validateRequest = compile({
	schema: rootSchema,
	method: "POST",
	url: "/verify",
	httpPart: "body",
});
assert.equal(validateRequest({ value: 7 }), true);
assert.equal(validateRequest({ value: "invalid" }), false);
const stringify = requireFastify("fast-json-stringify")(
	{
		...rootSchema,
		properties: {
			value: {
				$ref: requireStringifier("fast-uri").resolve(
					rootSchema.$id,
					rootSchema.properties.value.$ref,
				),
			},
		},
	},
	{ schema: { [valueSchema.$id]: valueSchema } },
);
assert.equal(stringify({ value: 7 }), '{"value":7}');
assert.throws(() => stringify({}));

// Check physical packages too, so an unused vulnerable copy cannot survive.
const modules = new URL("./node_modules/", import.meta.url);
const packagePaths = readdirSync(modules, { recursive: true });
if (existsSync(new URL("undici/package.json", modules))) {
	packagePaths.push("undici/package.json");
}
if (existsSync(new URL("fastify/package.json", modules))) {
	packagePaths.push("fastify/package.json");
}
let fastifyCopies = 0;
let undiciCopies = 0;
let braceExpansionCopies = 0;
const fastUriVersions = new Set();
for (const path of packagePaths) {
	if (
		path === "fast-uri/package.json" ||
		path.endsWith("/fast-uri/package.json")
	) {
		const version = JSON.parse(
			readFileSync(new URL(path, modules), "utf8"),
		).version;
		assert.ok(
			["3.1.8", "4.1.5"].includes(version),
			`Unexpected fast-uri ${version}`,
		);
		fastUriVersions.add(version);
	}
	if (
		path === "brace-expansion/package.json" ||
		path.endsWith("/brace-expansion/package.json")
	) {
		braceExpansionCopies += 1;
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"2.1.7",
		);
	}
	if (
		path === "fastify/package.json" ||
		path.endsWith("/fastify/package.json")
	) {
		fastifyCopies += 1;
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"5.12.5",
		);
	}
	if (path === "undici/package.json" || path.endsWith("/undici/package.json")) {
		undiciCopies += 1;
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"7.29.1",
		);
	}
	if (path === "uuid/package.json" || path.endsWith("/uuid/package.json")) {
		assert.equal(
			JSON.parse(readFileSync(new URL(path, modules), "utf8")).version,
			"11.1.1",
		);
	}
}

assert.deepEqual([...fastUriVersions].sort(), ["3.1.8", "4.1.5"]);
assert.ok(fastifyCopies > 0, "No physical Fastify package found");
assert.ok(undiciCopies > 0, "No physical undici package found");
assert.ok(
	braceExpansionCopies > 0,
	"No physical brace-expansion package found",
);

const Database = requireZero("@rocicorp/zero-sqlite3");
const db = new Database(":memory:");
assert.equal(db.prepare("select 1 as value").get().value, 1);
db.close();
console.log(
	`Zero 1.9.0, Fastify 5.12.5, fast-uri 3.1.8/4.1.5 consumers, UUID 11.1.1, brace-expansion 2.1.7, Node ${process.version}, bundled Undici ${process.versions.undici}, npm Undici 7.29.1, SQLite ${process.platform}/${process.arch} verified`,
);
