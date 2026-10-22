import assert from "node:assert/strict";
import { createRequire } from "node:module";

const shardURL = new URL(
	"../../node_modules/@rocicorp/zero/out/zero-cache/src/services/change-source/pg/schema/shard.js",
	import.meta.url,
);
const require = createRequire(shardURL);
const postgres = require("postgres");
const { setupTablesAndReplication } = await import(shardURL);
const { getPublicationInfo } = await import(
	new URL("./published.js", shardURL)
);
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice() {} });
const lc = {
	info() {},
	warn() {},
	debug() {},
	error() {},
	withContext() {
		return this;
	},
};
try {
	await sql`create publication focus_explicit_public for tables in schema public`;
	for (const [appID, publications] of [
		["focusdefault", []],
		["focusexplicit", ["focus_explicit_public"]],
	]) {
		await sql.begin((tx) =>
			setupTablesAndReplication(lc, tx, {
				appID,
				shardNum: 0,
				publications,
			}),
		);
	}
	const memberships =
		await sql`select pubname, schemaname, tablename, attnames from pg_publication_tables`;
	assert(
		memberships.some((r) => r.tablename === "focus_interval_start"),
		"acknowledgement publication positive control",
	);
	assert(
		!memberships.some(
			(r) =>
				r.tablename === "focus_interval_clock" ||
				r.schemaname === "server_private",
		),
		"private clock table and columns must be absent from every publication",
	);
	for (const pubname of new Set(memberships.map((r) => r.pubname))) {
		const { tables } = await getPublicationInfo(sql, [pubname]);
		assert(
			tables.some((t) => t.name === "focus_interval_start") ||
				!memberships.some(
					(r) =>
						r.pubname === pubname && r.tablename === "focus_interval_start",
				),
		);
		assert(
			!tables.some((t) => t.name === "focus_interval_clock"),
			"Zero publication reader must omit private timing columns",
		);
	}
	console.log(
		"default and explicit Zero publications exclude private clocks and their columns",
	);
} finally {
	await sql.end();
}
