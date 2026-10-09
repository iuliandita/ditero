// One-image role bundle configuration. Importing this module starts nothing.
//
// Importing this module performs no I/O and starts nothing. The pure exports
// (buildConfiguration, validateClusterState, validateVolumeTopdir, ...) take
// synthetic inputs so they can be tested without root paths or a database.
// The run command prepares only its current role and starts same-UID children.
//
// Error messages name env keys and contracts, never values.

import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
}

function fail(message) {
	throw new ConfigError(message);
}

const APP_UID = 1000;
const PG_UID = 1001;
const ZERO_UID = 1002;

const RUN = "/run/ditero";
const PG_TOP = "/var/lib/ditero/pg18";
const PG_DATA = `${PG_TOP}/data`;
const ZERO_TOP = "/var/lib/ditero/zero";
const ATTACHMENTS_TOP = "/var/lib/ditero/attachments";
const PG_STATE_FILE = `${PG_TOP}/ditero-init.state`;
const CLUSTER_STATE_FILE = `${RUN}/cluster-state`;

const DATABASE = "ditero";
const ADMIN_ROLE = "ditero_pgadmin";
const MIGRATOR_ROLE = "ditero_migrator";
const RUNTIME_ROLE = "ditero_runtime";
const ZERO_ROLE = "ditero_zero";
const PG_OS_USER = "postgres";
const PG_HOST = "postgres";
const PG_PORT = 5432;
const API_PORT = "3000";
const DEFAULT_SHARD_SCHEMA = "zero_0";
const SERVICE_PATH =
	"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const MAX_SECRET_BYTES = 64 * 1024;

export const FIXED = Object.freeze({
	uids: Object.freeze({ app: APP_UID, postgres: PG_UID, zero: ZERO_UID }),
	runDir: RUN,
	volumes: Object.freeze({
		postgres: PG_TOP,
		zero: ZERO_TOP,
		attachments: ATTACHMENTS_TOP,
	}),
	pgData: PG_DATA,
	pgStateFile: PG_STATE_FILE,
	clusterStateFile: CLUSTER_STATE_FILE,
	database: DATABASE,
	roles: Object.freeze({
		admin: ADMIN_ROLE,
		migrator: MIGRATOR_ROLE,
		runtime: RUNTIME_ROLE,
		zero: ZERO_ROLE,
	}),
	pgOsUser: PG_OS_USER,
});

// PostgreSQL-owner bootstrap records each initialization stage; interrupted
// state is refused on a later start.
export const INIT_STATE = Object.freeze({
	started: "initdb-started",
	complete: "initdb-complete",
	roles: "roles-complete",
});

// ---- environment contract -------------------------------------------------

// Secrets that accept NAME or NAME_FILE.
const REQUIRED_FILE_SECRETS = [
	"POSTGRES_PASSWORD",
	"DITERO_MIGRATION_DB_PASSWORD",
	"DITERO_RUNTIME_DB_PASSWORD",
	"ZERO_DATABASE_PASSWORD",
	"ZERO_ADMIN_PASSWORD",
	"BETTER_AUTH_SECRET",
	"DITERO_ENCRYPTION_KEY",
];
// Same set the current entrypoint passes through load_secret.
const OPTIONAL_FILE_SECRETS = [
	"DITERO_ENCRYPTION_KEY_NEXT",
	"GOOGLE_CLIENT_SECRET",
	"DITERO_ATTACHMENT_S3_ACCESS_KEY_ID",
	"DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY",
];
// Secrets with no _FILE form in current source: plain env only.
const PLAIN_SECRETS = [
	"DITERO_SMTP_PASSWORD",
	"DITERO_TELEGRAM_WEBHOOK_SECRET",
	"DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY",
];
// Validated or fixed here rather than passed through verbatim.
const SPECIAL = [
	"API_PORT",
	"NODE_ENV",
	"BETTER_AUTH_URL",
	"PUBLIC_ZERO_URL",
	"DITERO_ZERO_SHARD_SCHEMA",
	"DITERO_ATTACHMENT_STORAGE_DRIVER",
	"DITERO_ATTACHMENT_FS_PATH",
	"DITERO_ATTACHMENT_QUOTA_BYTES",
	"DITERO_ATTACHMENT_S3_BUCKET",
	"DITERO_ATTACHMENT_S3_REGION",
	"DITERO_ATTACHMENT_S3_ENDPOINT",
];
// Non-secret product config handed to the API unchanged.
const PASSTHROUGH = [
	"DITERO_ATTACHMENT_RETENTION_MS",
	"DITERO_ATTACHMENT_SWEEP_BATCH_SIZE",
	"DITERO_ATTACHMENT_SWEEP_MS",
	"DITERO_BACKGROUND_JOBS",
	"DITERO_DISCOVERY",
	"DITERO_MAX_QUEUED_PER_USER",
	"DITERO_MEMBER_INVITES",
	"DITERO_NATIVE_PUSH_RELAY_ORIGIN",
	"DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY",
	"DITERO_NATIVE_PUSH_VAPID_SUBJECT",
	"DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS",
	"DITERO_NOTIFY_DEADLINE_MS",
	"DITERO_OUTBOX_RETENTION_MS",
	"DITERO_OVERDUE_SWEEP_MS",
	"DITERO_PASSKEY_ORIGIN",
	"DITERO_PASSKEY_RP_ID",
	"DITERO_PRUNE_BATCH_SIZE",
	"DITERO_PRUNE_CADENCE_TICKS",
	"DITERO_PUBLIC_URL",
	"DITERO_REGISTRATION_MODE",
	"DITERO_REPLICA_ID",
	"DITERO_SCHEDULER_GRACE_MS",
	"DITERO_SCHEDULER_LATE_THRESHOLD_MS",
	"DITERO_SCHEDULER_TICK_MS",
	"DITERO_SMTP_ALLOW_INSECURE",
	"DITERO_SMTP_FROM",
	"DITERO_SMTP_HOST",
	"DITERO_SMTP_PORT",
	"DITERO_SMTP_SECURE",
	"DITERO_SMTP_USER",
	"DITERO_TELEGRAM_MAX_BOTS",
	"DITERO_TELEGRAM_MODE",
	"DITERO_TELEGRAM_POLL_TIMEOUT_SEC",
	"DITERO_TRUSTED_PROXIES",
	"DITERO_WORKER_BATCH_SIZE",
	"DITERO_WORKER_CONCURRENCY",
	"DITERO_WORKER_LEASE_MS",
	"DITERO_WORKER_TICK_MS",
	"GOOGLE_CLIENT_ID",
	"SERVE_STATIC_DIR",
	"TRUSTED_ORIGINS",
];
const S3_KEYS = [
	"DITERO_ATTACHMENT_S3_BUCKET",
	"DITERO_ATTACHMENT_S3_REGION",
	"DITERO_ATTACHMENT_S3_ENDPOINT",
	"DITERO_ATTACHMENT_S3_ACCESS_KEY_ID",
	"DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY",
];

const KNOWN = new Set([
	...REQUIRED_FILE_SECRETS,
	...REQUIRED_FILE_SECRETS.map((name) => `${name}_FILE`),
	...OPTIONAL_FILE_SECRETS,
	...OPTIONAL_FILE_SECRETS.map((name) => `${name}_FILE`),
	...PLAIN_SECRETS,
	...SPECIAL,
	...PASSTHROUGH,
]);

// A key inside one of these namespaces that is not in KNOWN is refused instead
// of silently dropped: DATABASE_URL overrides, ZERO_* knobs, POSTGRES_USER,
// PG* libpq variables, NODE_OPTIONS, the DITERO_E2E / DITERO_TEST_* seams, and
// the DITERO_URL / DITERO_TOKEN CLI client variables. Ambient names outside the
// namespaces (PATH, HOME, TERM, NO_COLOR, ...) are neither read nor forwarded.
const UNSUPPORTED_NAMESPACE =
	/^(DITERO_|ZERO_|POSTGRES_|PG|DATABASE_|BETTER_AUTH_|GOOGLE_|PUBLIC_|API_|TRUSTED_|SERVE_|NODE_|DEV$|MODE$|PROD$)/;

// Empty string counts as unset, matching the `${VAR:-}` compose convention and
// the current load_secret behaviour.
function present(value) {
	return typeof value === "string" && value !== "";
}

// Forwarded configuration is bounded single-line data; NUL and line breaks
// are refused for secret and nonsecret values.
function checkValue(name, value) {
	if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
		fail(`${name}: value exceeds the bounded configuration size`);
	}
	if (value.includes("\0")) fail(`${name}: value must not contain NUL`);
	if (/[\r\n]/.test(value)) fail(`${name}: value must be a single line`);
	return value;
}

function plainValue(env, name) {
	return present(env[name]) ? checkValue(name, env[name]) : undefined;
}

// Secret file convention (same as secret-file.sh): trailing line terminators
// are removed, an empty result is refused, everything else is kept byte for
// byte -- leading and trailing spaces included. An internal line break or NUL
// is refused.
export function parseSecretFileContent(name, raw) {
	let text;
	if (typeof raw === "string") {
		text = raw;
	} else {
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				raw,
			);
		} catch {
			fail(`${name}_FILE: content must be valid UTF-8`);
		}
	}
	const value = text.replace(/[\r\n]+$/, "");
	if (value === "") fail(`${name}_FILE: file is empty`);
	return checkValue(`${name}_FILE`, value);
}

function readRegularNoFollow(path, expected, maxBytes) {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino) {
			fail("file changed while it was being read");
		}
		if (st.size > maxBytes) fail("file is too large");
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

// Role credentials must be private regular files inside a private role-owned directory.
// The file and parent must have no group/other access
// whose path has no symlinks. Nothing is chmod'ed
// or chown'ed; unsafe inputs are refused. Throws ConfigError with a value-free
// reason.
export function defaultReadSecretFile(path) {
	if (
		!path.startsWith("/") ||
		path
			.split("/")
			.slice(1)
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail("path must be absolute and normalised");
	}
	const slash = path.lastIndexOf("/");
	const parent = slash === 0 ? "/" : path.slice(0, slash);
	const parentStat = lstatSync(parent);
	if (
		!parentStat.isDirectory() ||
		parentStat.uid !== process.getuid() ||
		(parentStat.mode & 0o077) !== 0
	) {
		fail(
			"parent must be owned by the role and inaccessible to group or others",
		);
	}
	if (realpathSync(parent) !== parent) {
		fail("parent path must not traverse symlinks");
	}
	const st = lstatSync(path);
	if (!st.isFile()) fail("must be a regular file, not a symlink");
	if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) {
		fail("must be role-owned and inaccessible to group or others");
	}
	return readRegularNoFollow(path, st, MAX_SECRET_BYTES);
}

function resolveSecret(env, name, { required, file }, readSecretFile) {
	const direct = plainValue(env, name);
	const path = file ? plainValue(env, `${name}_FILE`) : undefined;
	if (direct !== undefined && path !== undefined) {
		fail(`${name} and ${name}_FILE are both set`);
	}
	if (path !== undefined) {
		let raw;
		try {
			raw = readSecretFile(path);
		} catch (error) {
			fail(
				`${name}_FILE: ${error instanceof ConfigError ? error.message : "file is not readable"}`,
			);
		}
		return parseSecretFileContent(name, raw);
	}
	if (direct !== undefined) return direct;
	if (required)
		fail(`${name} is required${file ? ` (or set ${name}_FILE)` : ""}`);
	return undefined;
}

function checkFieldKey(name, value) {
	const key = Buffer.from(value, "base64");
	if (key.length !== 32 || key.toString("base64") !== value) {
		fail(`${name} must be canonical base64 of exactly 32 bytes`);
	}
}

function absoluteHttpUrl(name, value, { required }) {
	if (value === undefined) {
		if (required)
			fail(`${name} is required: set an explicit absolute http(s) URL`);
		return undefined;
	}
	if (value !== value.trim()) {
		fail(`${name} must not have leading or trailing whitespace`);
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		fail(`${name} must be an absolute http(s) URL`);
	}
	if (!["http:", "https:"].includes(url.protocol) || url.hostname === "") {
		fail(`${name} must be an absolute http(s) URL`);
	}
	if (url.username !== "" || url.password !== "") {
		fail(`${name} must not contain credentials`);
	}
	return value;
}

function scanUnsupported(env) {
	for (const name of Object.keys(env).sort()) {
		if (!present(env[name]) || KNOWN.has(name)) continue;
		if (UNSUPPORTED_NAMESPACE.test(name)) {
			fail(`${name} is not supported by the all-in-one image`);
		}
	}
}

// Mirrors attachmentStorageConfig(): same driver names, same stray-key rules,
// same S3 requirements. The filesystem path is fixed; in s3 mode the volume is
// still prepared and retained but unused.
function attachmentEnv(env, secret) {
	const driver =
		(plainValue(env, "DITERO_ATTACHMENT_STORAGE_DRIVER") ?? "").trim() ||
		"filesystem";
	if (driver !== "filesystem" && driver !== "s3") {
		fail('DITERO_ATTACHMENT_STORAGE_DRIVER: expected "filesystem" or "s3"');
	}
	const out = { DITERO_ATTACHMENT_STORAGE_DRIVER: driver };

	const quota = plainValue(env, "DITERO_ATTACHMENT_QUOTA_BYTES");
	if (quota !== undefined) {
		const digits = quota.trim();
		if (
			!/^[0-9]+$/.test(digits) ||
			!(Number(digits) > 0) ||
			!Number.isSafeInteger(Number(digits))
		) {
			fail("DITERO_ATTACHMENT_QUOTA_BYTES: expected a positive safe integer");
		}
		out.DITERO_ATTACHMENT_QUOTA_BYTES = quota;
	}

	const fsPath = plainValue(env, "DITERO_ATTACHMENT_FS_PATH");
	if (driver === "filesystem") {
		const stray = S3_KEYS.filter(
			(name) => present(env[name]) || present(env[`${name}_FILE`]),
		);
		if (stray.length > 0) {
			fail(`${stray.join(", ")} set while attachment storage uses filesystem`);
		}
		if (fsPath !== undefined && fsPath.trim() !== ATTACHMENTS_TOP) {
			fail(`DITERO_ATTACHMENT_FS_PATH is fixed at ${ATTACHMENTS_TOP}`);
		}
		out.DITERO_ATTACHMENT_FS_PATH = ATTACHMENTS_TOP;
		return out;
	}

	if (fsPath !== undefined) {
		fail("DITERO_ATTACHMENT_FS_PATH is set while attachment storage uses s3");
	}
	for (const name of [
		"DITERO_ATTACHMENT_S3_BUCKET",
		"DITERO_ATTACHMENT_S3_REGION",
	]) {
		const value = plainValue(env, name);
		if (value === undefined || value.trim() === "") {
			fail(`${name} is required for S3 attachment storage`);
		}
		out[name] = value;
	}
	const endpoint = plainValue(env, "DITERO_ATTACHMENT_S3_ENDPOINT");
	if (endpoint !== undefined && endpoint.trim() !== "") {
		const trimmed = endpoint.trim();
		let url;
		try {
			url = new URL(trimmed);
		} catch {
			fail(
				"DITERO_ATTACHMENT_S3_ENDPOINT must be an absolute HTTP or HTTPS URL without credentials",
			);
		}
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username !== "" ||
			url.password !== ""
		) {
			fail(
				"DITERO_ATTACHMENT_S3_ENDPOINT must be an absolute HTTP or HTTPS URL without credentials",
			);
		}
		out.DITERO_ATTACHMENT_S3_ENDPOINT = endpoint;
	}
	const accessKeyId = secret("DITERO_ATTACHMENT_S3_ACCESS_KEY_ID");
	const secretAccessKey = secret("DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY");
	if (Boolean(accessKeyId?.trim()) !== Boolean(secretAccessKey)) {
		fail(
			"DITERO_ATTACHMENT_S3_ACCESS_KEY_ID and DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY must be set together",
		);
	}
	if (accessKeyId?.trim() && secretAccessKey) {
		out.DITERO_ATTACHMENT_S3_ACCESS_KEY_ID = accessKeyId;
		out.DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY = secretAccessKey;
	}
	return out;
}

// ---- postgres files -------------------------------------------------------

export function renderPostgresConf() {
	return `${[
		`data_directory = '${PG_DATA}'`,
		`hba_file = '${RUN}/postgres/pg_hba.conf'`,
		`ident_file = '${RUN}/postgres/pg_ident.conf'`,
		"listen_addresses = '*'",
		`port = ${PG_PORT}`,
		`unix_socket_directories = '${RUN}/postgres'`,
		"unix_socket_permissions = 0700",
		"password_encryption = scram-sha-256",
		"wal_level = logical",
	].join("\n")}\n`;
}

// Local socket: peer, and only the postgres OS user mapped to the bootstrap
// admin. App roles get no local entry. TCP: SCRAM on the internal network, database
// `ditero` only. Anything unmatched is denied.
export function renderPgHba() {
	return `${[
		"# TYPE  DATABASE  USER            ADDRESS         METHOD",
		`local   all       ${ADMIN_ROLE}  peer map=ditero_os`,
		`host    ${DATABASE}    all             samenet         scram-sha-256`,
	].join("\n")}\n`;
}

export function renderPgIdent() {
	return `# MAPNAME  SYSTEM-USERNAME  DATABASE-USERNAME\nditero_os  ${PG_OS_USER}  ${ADMIN_ROLE}\n`;
}

// Fresh-cluster role bootstrap runs as the admin over the private socket.
// Passwords arrive through psql \getenv from the owner-local bootstrap
// environment; they are never in argv or in this text.
// Same grants as the previous init script, except the zero shard schema is now
// owned by the dedicated ditero_zero superuser, so default privileges are
// scoped FOR ROLE ditero_zero (the role that will create the tables).
export function roleBootstrapSql() {
	return `\\set ON_ERROR_STOP on
\\set ECHO none
\\set ECHO_HIDDEN off
\\set VERBOSITY terse
\\set SHOW_CONTEXT never
SELECT 1 / CASE WHEN :'ECHO' = 'none' AND :'ECHO_HIDDEN' = 'off' AND :'ON_ERROR_STOP' = 'on' THEN 1 ELSE 0 END;
SET log_statement TO 'none';
SET log_min_error_statement TO 'panic';
SET log_min_duration_statement TO '-1';
SET log_min_duration_sample TO '-1';
SET log_statement_sample_rate TO '0';
SET log_transaction_sample_rate TO '0';
SET log_duration TO 'off';
SET log_parameter_max_length TO '0';
SET log_parameter_max_length_on_error TO '0';
SET log_error_verbosity TO 'terse';
SET debug_print_parse TO 'off';
SET debug_print_rewritten TO 'off';
SET debug_print_plan TO 'off';
SET log_statement_stats TO 'off';
SET log_parser_stats TO 'off';
SET log_planner_stats TO 'off';
SET log_executor_stats TO 'off';
DO $ditero_logging$
BEGIN
  IF current_setting('log_statement') <> 'none'
    OR current_setting('log_min_error_statement') <> 'panic'
    OR current_setting('log_min_duration_statement') <> '-1'
    OR current_setting('log_min_duration_sample') <> '-1'
    OR current_setting('log_statement_sample_rate') <> '0'
    OR current_setting('log_transaction_sample_rate') <> '0'
    OR current_setting('log_duration') <> 'off'
    OR current_setting('log_parameter_max_length') <> '0'
    OR current_setting('log_parameter_max_length_on_error') <> '0'
    OR current_setting('log_error_verbosity') <> 'terse'
    OR current_setting('debug_print_parse') <> 'off'
    OR current_setting('debug_print_rewritten') <> 'off'
    OR current_setting('debug_print_plan') <> 'off'
    OR current_setting('log_statement_stats') <> 'off'
    OR current_setting('log_parser_stats') <> 'off'
    OR current_setting('log_planner_stats') <> 'off'
    OR current_setting('log_executor_stats') <> 'off' THEN
    RAISE EXCEPTION 'role bootstrap logging settings refused';
  END IF;
END
$ditero_logging$;
\\getenv migration_password DITERO_MIGRATION_DB_PASSWORD
\\getenv runtime_password DITERO_RUNTIME_DB_PASSWORD
\\getenv zero_password ZERO_DATABASE_PASSWORD
\\getenv zero_shard_schema DITERO_ZERO_SHARD_SCHEMA
BEGIN;
CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'migration_password';
CREATE ROLE ${RUNTIME_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD :'runtime_password';
CREATE ROLE ${ZERO_ROLE} LOGIN SUPERUSER PASSWORD :'zero_password';
COMMIT;
CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR_ROLE};
\\connect ${DATABASE}
BEGIN;
ALTER SCHEMA public OWNER TO ${MIGRATOR_ROLE};
GRANT CONNECT ON DATABASE ${DATABASE} TO ${RUNTIME_ROLE};
GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${RUNTIME_ROLE};

CREATE SCHEMA :"zero_shard_schema" AUTHORIZATION ${ZERO_ROLE};
GRANT USAGE ON SCHEMA :"zero_shard_schema" TO ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ZERO_ROLE} IN SCHEMA :"zero_shard_schema"
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${ZERO_ROLE} IN SCHEMA :"zero_shard_schema"
	GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${RUNTIME_ROLE}, ${MIGRATOR_ROLE};
COMMIT;
`;
}

// ---- configuration --------------------------------------------------------

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

function dbUrl(role, password) {
	return `postgres://${role}:${encodeURIComponent(password)}@${PG_HOST}:${PG_PORT}/${DATABASE}`;
}

// Pure role validation; sibling credentials are refused rather than filtered.
export function buildConfiguration(
	role,
	env,
	readSecretFile = defaultReadSecretFile,
) {
	const roles = {
		postgres: PG_UID,
		migrate: APP_UID,
		api: APP_UID,
		zero: ZERO_UID,
	};
	if (!Object.hasOwn(roles, role)) fail("unknown bundle role");
	scanUnsupported(env);
	const allowed = {
		postgres: [
			"POSTGRES_PASSWORD",
			"DITERO_MIGRATION_DB_PASSWORD",
			"DITERO_RUNTIME_DB_PASSWORD",
			"ZERO_DATABASE_PASSWORD",
		],
		migrate: ["DITERO_MIGRATION_DB_PASSWORD"],
		api: [
			"DITERO_RUNTIME_DB_PASSWORD",
			"BETTER_AUTH_SECRET",
			"DITERO_ENCRYPTION_KEY",
		],
		zero: ["ZERO_DATABASE_PASSWORD", "ZERO_ADMIN_PASSWORD"],
	}[role];
	for (const name of REQUIRED_FILE_SECRETS) {
		if (
			!allowed.includes(name) &&
			(present(env[name]) || present(env[`${name}_FILE`]))
		)
			fail(`${name} is not allowed for this role`);
	}
	if (role !== "api") {
		for (const name of [
			...OPTIONAL_FILE_SECRETS,
			...PLAIN_SECRETS,
			...PASSTHROUGH.filter((name) => name !== "SERVE_STATIC_DIR"),
			"BETTER_AUTH_URL",
			"PUBLIC_ZERO_URL",
			...S3_KEYS,
			"DITERO_ATTACHMENT_STORAGE_DRIVER",
			"DITERO_ATTACHMENT_FS_PATH",
			"DITERO_ATTACHMENT_QUOTA_BYTES",
		]) {
			if (present(env[name]) || present(env[`${name}_FILE`]))
				fail(`${name} is not allowed for this role`);
		}
	}
	const secret = (name, required = true) =>
		resolveSecret(env, name, { required, file: true }, readSecretFile);
	const values = Object.fromEntries(
		allowed.map((name) => [name, secret(name)]),
	);
	const out = { PATH: SERVICE_PATH, HOME: RUN, NODE_ENV: "production" };
	if (role === "postgres") {
		const passwords = Object.values(values);
		if (new Set(passwords).size !== passwords.length)
			fail("database passwords must differ");
		Object.assign(out, values, {
			PGHOST: `${RUN}/postgres`,
			PGUSER: ADMIN_ROLE,
			PGDATABASE: "postgres",
			DITERO_ZERO_SHARD_SCHEMA: DEFAULT_SHARD_SCHEMA,
		});
	} else if (role === "migrate") {
		out.DATABASE_URL = dbUrl(
			MIGRATOR_ROLE,
			values.DITERO_MIGRATION_DB_PASSWORD,
		);
	} else if (role === "api") {
		checkFieldKey("DITERO_ENCRYPTION_KEY", values.DITERO_ENCRYPTION_KEY);
		Object.assign(out, {
			API_PORT,
			DATABASE_URL: dbUrl(RUNTIME_ROLE, values.DITERO_RUNTIME_DB_PASSWORD),
			BETTER_AUTH_SECRET: values.BETTER_AUTH_SECRET,
			DITERO_ENCRYPTION_KEY: values.DITERO_ENCRYPTION_KEY,
			BETTER_AUTH_URL: absoluteHttpUrl(
				"BETTER_AUTH_URL",
				plainValue(env, "BETTER_AUTH_URL"),
				{ required: true },
			),
			PUBLIC_ZERO_URL: absoluteHttpUrl(
				"PUBLIC_ZERO_URL",
				plainValue(env, "PUBLIC_ZERO_URL"),
				{ required: true },
			),
			DITERO_ZERO_SHARD_SCHEMA: DEFAULT_SHARD_SCHEMA,
		});
		for (const name of OPTIONAL_FILE_SECRETS) {
			const value = secret(name, false);
			if (value !== undefined) out[name] = value;
		}
		if (out.DITERO_ENCRYPTION_KEY_NEXT !== undefined)
			checkFieldKey(
				"DITERO_ENCRYPTION_KEY_NEXT",
				out.DITERO_ENCRYPTION_KEY_NEXT,
			);
		for (const name of [...PLAIN_SECRETS, ...PASSTHROUGH]) {
			const value = plainValue(env, name);
			if (value !== undefined) out[name] = value;
		}
		Object.assign(
			out,
			attachmentEnv(env, (name) => secret(name, false)),
		);
	} else {
		Object.assign(out, {
			PATH: `/opt/app/node_modules/.bin:${SERVICE_PATH}`,
			ZERO_IN_CONTAINER: "1",
			ZERO_LITESTREAM_CONFIG_PATH: "/etc/litestream.yml",
			ZERO_LITESTREAM_EXECUTABLE: "/usr/local/bin/litestream",
			ZERO_LITESTREAM_EXECUTABLE_V5: "/usr/local/bin/litestream-v5",
			ZERO_LOG_FORMAT: "json",
			ZERO_SERVER_VERSION: "1.9.0",
			ZERO_UPSTREAM_DB: dbUrl(ZERO_ROLE, values.ZERO_DATABASE_PASSWORD),
			ZERO_CVR_DB: dbUrl(ZERO_ROLE, values.ZERO_DATABASE_PASSWORD),
			ZERO_CHANGE_DB: dbUrl(ZERO_ROLE, values.ZERO_DATABASE_PASSWORD),
			ZERO_REPLICA_FILE: `${ZERO_TOP}/replica.db`,
			ZERO_QUERY_URL: `http://api:${API_PORT}/api/zero/query`,
			ZERO_MUTATE_URL: `http://api:${API_PORT}/api/zero/mutate`,
			ZERO_ENABLE_CRUD_MUTATIONS: "false",
			ZERO_ADMIN_PASSWORD: values.ZERO_ADMIN_PASSWORD,
		});
	}
	for (const name of ["API_PORT", "NODE_ENV", "DITERO_ZERO_SHARD_SCHEMA"]) {
		const expected = {
			API_PORT,
			NODE_ENV: "production",
			DITERO_ZERO_SHARD_SCHEMA: DEFAULT_SHARD_SCHEMA,
		}[name];
		if (present(env[name]) && env[name] !== expected) fail(`${name} is fixed`);
	}
	return deepFreeze({ role, uid: roles[role], env: out });
}

// ---- volume and cluster state (pure) --------------------------------------

// snapshot: { exists, type: "dir"|"symlink"|"file"|"other", uid, mode, entries }
// Both empty and retained mount roots must already have the role owner and
// private permissions. No runtime ownership adoption or repair is permitted.
export function validateVolumeTopdir(snapshot, { name, uid }) {
	if (!snapshot?.exists) fail(`${name} volume mount point is missing`);
	if (snapshot.type !== "dir") {
		fail(`${name} volume mount point must be a real directory`);
	}
	if (snapshot.entries.length === 0) {
		if (snapshot.uid !== uid || snapshot.mode !== 0o700)
			fail(`${name} empty volume requires role ownership and mode0700`);
		return { fresh: true, adopt: false };
	}
	if (snapshot.uid !== uid) {
		fail(
			`${name} volume holds data not owned by uid ${uid}; refusing to chown`,
		);
	}
	if ((snapshot.mode & 0o077) !== 0) {
		fail(
			`${name} volume holds data open to group or others; refusing to chmod`,
		);
	}
	return { fresh: false, adopt: false };
}

const PG_TOP_ENTRIES = new Set(["data", "ditero-init.state"]);

// topdir/data are snapshots as above; pgVersion and marker are the raw
// contents of PG_VERSION and ditero-init.state, or null when absent.
// Returns { action: "init" | "reuse", adoptTopdir }; throws on anything else.
// There is no replay: an interrupted first boot is refused, never resumed.
export function validateClusterState({
	topdir,
	data,
	pgVersion,
	marker,
	uid = PG_UID,
}) {
	const top = validateVolumeTopdir(topdir, { name: "postgres", uid });
	// Accept the exact single-LF representation emitted by bootstrap; never trim data.
	if (typeof marker === "string" && marker.endsWith("\n"))
		marker = marker.slice(0, -1);
	if (top.fresh) return { action: "init", adoptTopdir: top.adopt };

	if (topdir.entries.some((entry) => !PG_TOP_ENTRIES.has(entry))) {
		fail(
			"postgres volume contains unknown entries; refusing to initialise or reuse",
		);
	}
	if (marker === INIT_STATE.started || marker === INIT_STATE.complete) {
		fail(
			`postgres volume holds an interrupted first boot (${marker}); refusing to replay -- restore a backup or empty the volume`,
		);
	}
	if (marker !== INIT_STATE.roles) {
		fail("postgres volume has no valid initialisation marker; refusing");
	}
	if (!data?.exists || data.type !== "dir") {
		fail("postgres data directory is missing or not a real directory");
	}
	if (data.uid !== uid)
		fail(`postgres data directory is not owned by uid ${uid}`);
	if ((data.mode & 0o077) !== 0) {
		fail("postgres data directory is open to group or others");
	}
	if (typeof pgVersion !== "string" || pgVersion.replace(/\n$/, "") !== "18") {
		fail("postgres data directory PG_VERSION must be exactly 18");
	}
	return { action: "reuse", adoptTopdir: false };
}

// ---- prepare (the only code that touches the machine) ---------------------

function snapshotPath(path) {
	let st;
	try {
		st = lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return { exists: false };
		throw error;
	}
	const type = st.isSymbolicLink()
		? "symlink"
		: st.isDirectory()
			? "dir"
			: st.isFile()
				? "file"
				: "other";
	return {
		exists: true,
		type,
		uid: st.uid,
		mode: st.mode & 0o7777,
		entries: type === "dir" ? readdirSync(path).sort() : [],
	};
}

function readOptionalSmallFile(path) {
	let st;
	try {
		st = lstatSync(path);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	if (!st.isFile()) fail("postgres volume state file is not a regular file");
	return readRegularNoFollow(path, st, 256).toString("utf8");
}

function snapshotCluster() {
	const topdir = snapshotPath(PG_TOP);
	const hasData = topdir.type === "dir" && topdir.entries.includes("data");
	const data = hasData ? snapshotPath(PG_DATA) : { exists: false };
	return {
		topdir,
		data,
		pgVersion:
			data.exists && data.type === "dir"
				? readOptionalSmallFile(`${PG_DATA}/PG_VERSION`)
				: null,
		marker:
			topdir.type === "dir" && topdir.entries.includes("ditero-init.state")
				? readOptionalSmallFile(PG_STATE_FILE)
				: null,
	};
}

function ensureDir({ path, mode, uid }) {
	const snap = snapshotPath(path);
	if (!snap.exists) {
		mkdirSync(path, { mode });
		return;
	}
	if (snap.type !== "dir" || snap.uid !== uid || snap.mode !== mode)
		fail("runtime directory ownership or mode refused");
}
function writePrivate(path, content) {
	const fd = openSync(
		path,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function prepare(config) {
	const { role, uid } = config;
	if (process.getuid() !== uid || process.getgid() !== uid)
		fail("wrong role identity");
	ensureDir({ path: RUN, mode: 0o700, uid });
	if (role === "postgres") {
		const state = validateClusterState(snapshotCluster());
		ensureDir({ path: `${RUN}/postgres`, mode: 0o700, uid });
		for (const [name, content] of Object.entries({
			"postgresql.conf": renderPostgresConf(),
			"pg_hba.conf": renderPgHba(),
			"pg_ident.conf": renderPgIdent(),
		}))
			writePrivate(`${RUN}/postgres/${name}`, content);
		writePrivate(CLUSTER_STATE_FILE, `${state.action}\n`);
		if (state.action === "init") {
			writePrivate(
				`${RUN}/postgres/initdb-password`,
				`${config.env.POSTGRES_PASSWORD}\n`,
			);
			writePrivate(`${RUN}/postgres/role-init.sql`, roleBootstrapSql());
		}
	} else if (role === "api" || role === "zero") {
		validateVolumeTopdir(
			snapshotPath(role === "api" ? ATTACHMENTS_TOP : ZERO_TOP),
			{ name: role, uid },
		);
	}
}
function health(config) {
	const call = (command, args, env = config.env) =>
		spawnSync(command, args, { env, stdio: "ignore", timeout: 5000 }).status ===
		0;
	if (config.role === "postgres")
		return (
			readOptionalSmallFile(PG_STATE_FILE) === "roles-complete\n" &&
			call("psql", ["-X", "-Atqc", "SELECT 1"])
		);
	if (config.role === "zero")
		return call("curl", [
			"-fsS",
			"--max-time",
			"3",
			"--noproxy",
			"*",
			"http://127.0.0.1:4848/keepalive",
		]);
	if (config.role !== "api") return false;
	const url = new URL(config.env.DATABASE_URL);
	const env = {
		PATH: SERVICE_PATH,
		PGHOST: url.hostname,
		PGPORT: url.port,
		PGDATABASE: DATABASE,
		PGUSER: RUNTIME_ROLE,
		PGPASSWORD: decodeURIComponent(url.password),
		PGCONNECT_TIMEOUT: "3",
		PGOPTIONS: "-c statement_timeout=3000",
	};
	const db = spawnSync(
		"psql",
		["-X", "-Atqc", "SELECT current_user || '|' || current_database()"],
		{ env, encoding: "utf8", timeout: 5000 },
	);
	if (db.status !== 0 || db.stdout.trim() !== "ditero_runtime|ditero")
		return false;
	if (
		!call("curl", [
			"-fsS",
			"--max-time",
			"3",
			"--noproxy",
			"*",
			"http://127.0.0.1:3000/health",
		])
	)
		return false;
	return ["query", "mutate"].every((route) => {
		const r = spawnSync(
			"curl",
			[
				"-sS",
				"--max-time",
				"3",
				"--noproxy",
				"*",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"-X",
				"POST",
				`http://127.0.0.1:3000/api/zero/${route}`,
			],
			{ env: config.env, encoding: "utf8", timeout: 5000 },
		);
		return r.status === 0 && r.stdout === "401";
	});
}
export function startHealthMonitor({
	probe,
	onFailure,
	now = Date.now,
	intervalMs = 5000,
	startupMs = 120000,
	failureLimit = 3,
}) {
	let stopped = false,
		timer,
		failures = 0,
		hasBeenHealthy = false;
	const started = now();
	async function tick() {
		let healthy = false;
		try {
			healthy = await probe();
		} catch {
			healthy = false;
		}
		if (stopped) return;
		if (healthy) {
			hasBeenHealthy = true;
			failures = 0;
		} else if (hasBeenHealthy || now() - started >= startupMs) failures++;
		if (failures >= failureLimit) {
			stopped = true;
			onFailure();
			return;
		}
		timer = setTimeout(tick, intervalMs);
	}
	timer = setTimeout(tick, intervalMs);
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
function run(config) {
	prepare(config);
	const commands = {
		postgres: ["/usr/local/lib/ditero-aio/bootstrap.sh"],
		migrate: ["bun", "run", "/app/aio/migrate-locked.ts"],
		api: ["bun", "run", "src/server/index.ts"],
		zero: ["zero-cache"],
	};
	const [command, ...args] = commands[config.role];
	const child = spawn(command, args, {
		env: config.env,
		cwd: config.role === "zero" ? "/opt/app" : "/app",
		stdio: "inherit",
		detached: true,
	});
	let stopping = false,
		failed = false,
		timer,
		probeChild,
		probeTimer;
	let stopMonitoring = () => {};
	const signalGroup = (pid, signal) => {
		if (pid) {
			try {
				process.kill(-pid, signal);
			} catch {
				/* Exit events retain the first failure. */
			}
		}
	};
	function cancelProbe() {
		clearTimeout(probeTimer);
		signalGroup(probeChild?.pid, "SIGKILL");
	}
	function stop(signal) {
		if (stopping) return;
		stopping = true;
		stopMonitoring();
		cancelProbe();
		signalGroup(child.pid, config.role === "postgres" ? "SIGINT" : signal);
		timer = setTimeout(() => {
			failed = true;
			signalGroup(child.pid, "SIGKILL");
		}, 10000);
	}
	if (config.role !== "migrate") {
		stopMonitoring = startHealthMonitor({
			probe: () =>
				new Promise((resolve) => {
					probeChild = spawn(
						process.execPath,
						[fileURLToPath(import.meta.url), "health", config.role],
						{ env: process.env, stdio: "ignore", detached: true },
					);
					probeTimer = setTimeout(
						() => signalGroup(probeChild.pid, "SIGKILL"),
						25000,
					);
					probeChild.once("error", () => {
						clearTimeout(probeTimer);
						probeChild = undefined;
						resolve(false);
					});
					probeChild.once("exit", (code) => {
						clearTimeout(probeTimer);
						probeChild = undefined;
						resolve(code === 0);
					});
				}),
			onFailure: () => {
				failed = true;
				process.stderr.write("ditero: sustained role health failure\n");
				stop("SIGTERM");
			},
		});
	}
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
		process.on(signal, () => stop(signal));
	child.on("error", () => {
		failed = true;
		stopMonitoring();
		cancelProbe();
		process.stderr.write("ditero: role launch failed\n");
		process.exitCode = 1;
	});
	child.on("exit", (code) => {
		clearTimeout(timer);
		stopMonitoring();
		cancelProbe();
		process.exitCode = failed
			? 1
			: stopping
				? 0
				: config.role === "migrate"
					? (code ?? 1)
					: code || 1;
	});
}
function main(argv) {
	if (argv.length !== 2 || !["run", "health"].includes(argv[0]))
		fail("usage: config.mjs run|health postgres|migrate|api|zero");
	const config = buildConfiguration(argv[1], process.env);
	if (
		process.getuid() !== config.uid ||
		process.getgid() !== config.uid ||
		process.getgroups().some((group) => group !== config.uid)
	)
		fail("wrong role identity");
	if (argv[0] === "health") process.exitCode = health(config) ? 0 : 1;
	else run(config);
}
if (
	process.argv[1] &&
	process.argv[1] !== "-" &&
	fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(
			`ditero: ${error instanceof ConfigError ? error.message : "role configuration failed"}\n`,
		);
		process.exitCode = 1;
	}
}
