import assert from "node:assert/strict";
import { register } from "node:module";

// This in-memory hydrate/serialize check never opens SQLite. Reject DB use.
register(
	`data:text/javascript,${encodeURIComponent(`
export function resolve(spec, context, next) {
 if (spec === '@rocicorp/zero-sqlite3') return {
  url: 'data:text/javascript,' + encodeURIComponent("export default class Database {constructor(){throw new Error('SQLite must not be used in this serializer probe')}}; export class SqliteError extends Error {}"),
  shortCircuit: true,
 };
 return next(spec, context);
}
`)}`,
	import.meta.url,
);
const root = new URL(
	process.env.FOCUS_ZERO_OUT ?? "../../node_modules/@rocicorp/zero/out/",
	import.meta.url,
);
const { hydrate } = await import(
	new URL("zero-cache/src/services/view-syncer/pipeline-driver.js", root)
);
const { ClientHandler } = await import(
	new URL("zero-cache/src/services/view-syncer/client-handler.js", root)
);
const table = "focus_interval_start";
const pk = ["user_id", "interval_id"];
let data = "";
for await (const chunk of process.stdin) data += chunk;
const row = { ...JSON.parse(data), _0_version: "01" };
const clientSchema = {
	tables: {
		[table]: {
			columns: { user_id: { type: "string" }, interval_id: { type: "string" } },
			primaryKey: pk,
		},
	},
};
const specs = new Map([
	[table, { tableSpec: { primaryKey: pk, minRowVersion: "00" } }],
]);
const input = {
	fetch: () => [{ row, relationships: {} }],
	getSchema: () => ({ tableName: table, system: "client", relationships: {} }),
};
const changes = [...hydrate(input, "query", clientSchema, specs)];
assert.equal(changes[0].row.started_at, undefined);
const sent = [];
const lc = {
	withContext() {
		return this;
	},
};
const downstream = {
	push(msg) {
		sent.push(
			Array.isArray(msg)
				? msg
				: msg.serialized
					? JSON.parse(msg.serialized)
					: msg.message,
		);
		return { result: Promise.resolve() };
	},
	fail(e) {
		throw e;
	},
};
const handler = new ClientHandler(
	lc,
	"group",
	"client",
	"ws",
	{ appID: "zero", shardNum: 0 },
	null,
	downstream,
);
const version = { stateVersion: "01" };
const poker = handler.startPoke(version);
const { _0_version, ...contents } = changes[0].row;
await poker.addPatch({
	toVersion: version,
	patch: {
		type: "row",
		op: "put",
		id: { schema: "", table, rowKey: changes[0].rowKey },
		contents,
	},
});
await poker.end(version);
const value = sent.find((m) => m[0] === "pokePart")[1].rowsPatch[0].value;
assert.equal(value.started_at, undefined);
assert.deepEqual(Object.keys(value).sort(), ["interval_id", "user_id"]);
console.log(JSON.stringify(value));
