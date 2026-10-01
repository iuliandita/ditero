import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs only inside the runner's zero-cache container, with bounded IDs on stdin.
let stage = "input";
const startedAt = Date.now();
let db;
let transactionOpen = false;
let result;
let backupDirectory;
try {
	const input = readFileSync(0, "utf8");
	if (Buffer.byteLength(input) > 4096) throw new RangeError();
	const selection = JSON.parse(input);
	const limits = { accounts: 4, dashboards: 2, workspaces: 5, memberships: 8 };
	if (
		Object.keys(selection).length !== 4 ||
		Object.entries(limits).some(([key, limit]) => {
			const values = selection[key];
			return (
				!Array.isArray(values) ||
				values.length > limit ||
				new Set(values).size !== values.length ||
				values.some(
					(id) => typeof id !== "string" || !/^[\w-]{1,128}$/.test(id),
				)
			);
		})
	)
		throw new RangeError();
	stage = "open";
	const requireZero = createRequire(
		realpathSync("/opt/app/node_modules/@rocicorp/zero/package.json"),
	);
	const Database = requireZero("@rocicorp/zero-sqlite3");
	const servingFile = process.env.E2E_DIAGNOSTIC_SERVING_FILE;
	if (
		!["/data/replica.db", "/data/replica.db-serving-copy"].includes(servingFile)
	)
		throw new RangeError();
	db = new Database(servingFile, {
		readonly: true,
		fileMustExist: true,
	});
	db.pragma("query_only = ON");
	db.pragma("busy_timeout = 1000");
	const journalMode = db.pragma("journal_mode", { simple: true });
	if (journalMode !== "wal2") throw new Error();
	db.exec("BEGIN");
	transactionOpen = true;
	stage = "query";
	const metadata = db
		.prepare(`select s.stateVersion, s.writeTimeMs, c.replicaVersion
		 from "_zero.replicationState" s join "_zero.replicationConfig" c using(lock)`)
		.all();
	const fields = {
		dashboard: "r.owner_id, r.workspace_id, r.scope",
		workspace: "r.kind, r.owner_id",
		membership: "r.user_id, r.workspace_id, r.role",
	};
	const tables = {
		dashboard: "dashboards",
		workspace: "workspaces",
		membership: "memberships",
	};
	const rows = Object.entries(tables).flatMap(([table, key]) => {
		const query =
			db.prepare(`select ? as expectedID, r.id is not null as rowFound,
		 r.id, ${fields[table]}, r._0_version as rowVersion
		 from (select 1) e left join "${table}" r on r.id = ?`);
		return selection[key].map((id) => ({ table, ...query.get(id, id) }));
	});
	const predicate =
		db.prepare(`select ? as accountID, ? as dashboardID, exists (
	 select 1 from dashboard d where d.id = ? and (
	  (d.scope = 'personal' and d.owner_id = ?) or
	  (d.scope = 'workspace' and exists (
	   select 1 from workspace w where w.id = d.workspace_id and exists (
	    select 1 from membership m where m.workspace_id = w.id and m.user_id = ?
	   )
	  ))
	 )
	) as visible`);
	const visibility = selection.accounts.flatMap((accountID) =>
		selection.dashboards.map((dashboardID) =>
			predicate.get(accountID, dashboardID, dashboardID, accountID, accountID),
		),
	);
	stage = "backup";
	backupDirectory = mkdtempSync(join(tmpdir(), "sharing-replica-"));
	const backupFile = join(backupDirectory, "snapshot.sqlite");
	await db.backup(backupFile);
	const backup = new Database(backupFile, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const backupMetadata = backup
			.prepare(`select s.stateVersion, s.writeTimeMs, c.replicaVersion
			 from "_zero.replicationState" s join "_zero.replicationConfig" c using(lock)`)
			.all();
		if (JSON.stringify(backupMetadata) !== JSON.stringify(metadata))
			throw new Error();
	} finally {
		backup.close();
	}
	result = {
		startedAt,
		servingFile,
		journalMode,
		backupVerified: true,
		metadata,
		rows,
		visibility,
	};
} catch (error) {
	result = {
		startedAt,
		stage,
		error: error instanceof RangeError ? "RangeError" : "Error",
	};
} finally {
	try {
		if (transactionOpen) db.exec("ROLLBACK");
	} catch {
		result = { startedAt, stage: "rollback", error: "Error" };
	} finally {
		try {
			db?.close();
			if (backupDirectory) rmSync(backupDirectory, { recursive: true });
		} catch {
			result = { startedAt, stage: "close", error: "Error" };
		}
	}
}
process.stdout.write(JSON.stringify({ ...result, finishedAt: Date.now() }));
