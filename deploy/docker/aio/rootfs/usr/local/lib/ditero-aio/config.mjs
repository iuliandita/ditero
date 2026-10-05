// All-in-one image configuration builder. Standalone ESM, builtin fs only.
//
// Importing this module performs no I/O and starts nothing. The pure exports
// (buildConfiguration, validateClusterState, validateVolumeTopdir, ...) take
// synthetic inputs so they can be tested without root paths or a database.
// `node config.mjs prepare` is the only entrypoint that touches the machine.
//
// Error messages name env keys and contracts, never values.

import {
	chmodSync,
	chownSync,
	closeSync,
	constants,
	fchmodSync,
	fchownSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
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
const CLUSTER_STATE_FILE = `${RUN}/bootstrap/cluster-state`;

const DATABASE = "ditero";
const ADMIN_ROLE = "ditero_pgadmin";
const MIGRATOR_ROLE = "ditero_migrator";
const RUNTIME_ROLE = "ditero_runtime";
const ZERO_ROLE = "ditero_zero";
const PG_OS_USER = "postgres";
const PG_HOST = "127.0.0.1";
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

// Lifecycle of ditero-init.state in the postgres volume. bootstrap.sh writes
// the first two; the role-init oneshot (next stage) writes the last.
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

// Values travel through single-line envdir files, so NUL and line breaks are
// refused for every forwarded value, secret or not.
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

// Default secret reader. The file must be a regular, non-symlink, root-owned
// file that group/others cannot write, inside a root-only root-owned directory
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
		parentStat.uid !== 0 ||
		(parentStat.mode & 0o077) !== 0
	) {
		fail(
			"parent must be a root-owned directory inaccessible to group or others",
		);
	}
	if (realpathSync(parent) !== parent) {
		fail("parent path must not traverse symlinks");
	}
	const st = lstatSync(path);
	if (!st.isFile()) fail("must be a regular file, not a symlink");
	if (st.uid !== 0 || (st.mode & 0o022) !== 0) {
		fail("must be root-owned and not writable by group or others");
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
		`listen_addresses = '${PG_HOST}'`,
		`port = ${PG_PORT}`,
		`unix_socket_directories = '${RUN}/postgres'`,
		"unix_socket_permissions = 0700",
		"password_encryption = scram-sha-256",
		"wal_level = logical",
	].join("\n")}\n`;
}

// Local socket: peer, and only the postgres OS user mapped to the bootstrap
// admin. App roles get no local entry. TCP: scram on loopback, database
// `ditero` only. Anything unmatched is denied.
export function renderPgHba() {
	return `${[
		"# TYPE  DATABASE  USER            ADDRESS         METHOD",
		`local   all       ${ADMIN_ROLE}  peer map=ditero_os`,
		`host    ${DATABASE}    all             127.0.0.1/32    scram-sha-256`,
	].join("\n")}\n`;
}

export function renderPgIdent() {
	return `# MAPNAME  SYSTEM-USERNAME  DATABASE-USERNAME\nditero_os  ${PG_OS_USER}  ${ADMIN_ROLE}\n`;
}

// Role bootstrap for a freshly initialised cluster, run once by the role-init
// oneshot as the admin over the private socket. Passwords arrive through psql
// \getenv from the oneshot's envdir; they are never in argv or in this text.
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

function service(name, uid, env, extra = {}) {
	const dir = `${RUN}/${name}`;
	return { name, uid, gid: uid, dir, envDir: `${dir}/env`, env, ...extra };
}

// Validates every input and returns the full plan: one explicit env dictionary
// per service, the directories to create, and the files to stage. Nothing is
// written here. `readSecretFile(path)` returns bytes or a string and may be
// replaced in tests.
export function buildConfiguration(
	env,
	readSecretFile = defaultReadSecretFile,
) {
	scanUnsupported(env);
	const requiredSecret = (name) =>
		resolveSecret(env, name, { required: true, file: true }, readSecretFile);
	const optionalSecret = (name) =>
		resolveSecret(env, name, { required: false, file: true }, readSecretFile);

	if (present(env.API_PORT) && env.API_PORT !== API_PORT) {
		fail(`API_PORT is fixed at ${API_PORT}`);
	}
	if (present(env.NODE_ENV) && env.NODE_ENV !== "production") {
		fail("NODE_ENV is fixed at production");
	}
	if (
		present(env.DITERO_ZERO_SHARD_SCHEMA) &&
		env.DITERO_ZERO_SHARD_SCHEMA !== DEFAULT_SHARD_SCHEMA
	) {
		// Zero has no supported key here to move its shard schema.
		fail(`DITERO_ZERO_SHARD_SCHEMA is fixed at ${DEFAULT_SHARD_SCHEMA}`);
	}

	const dbPasswords = {
		POSTGRES_PASSWORD: requiredSecret("POSTGRES_PASSWORD"),
		DITERO_MIGRATION_DB_PASSWORD: requiredSecret(
			"DITERO_MIGRATION_DB_PASSWORD",
		),
		DITERO_RUNTIME_DB_PASSWORD: requiredSecret("DITERO_RUNTIME_DB_PASSWORD"),
		ZERO_DATABASE_PASSWORD: requiredSecret("ZERO_DATABASE_PASSWORD"),
	};
	const dbNames = Object.keys(dbPasswords);
	for (let i = 0; i < dbNames.length; i++) {
		for (let j = i + 1; j < dbNames.length; j++) {
			if (dbPasswords[dbNames[i]] === dbPasswords[dbNames[j]]) {
				fail(`${dbNames[i]} and ${dbNames[j]} must be different`);
			}
		}
	}
	const zeroAdminPassword = requiredSecret("ZERO_ADMIN_PASSWORD");
	const authSecret = requiredSecret("BETTER_AUTH_SECRET");
	const encryptionKey = requiredSecret("DITERO_ENCRYPTION_KEY");
	checkFieldKey("DITERO_ENCRYPTION_KEY", encryptionKey);
	const encryptionKeyNext = optionalSecret("DITERO_ENCRYPTION_KEY_NEXT");
	if (encryptionKeyNext !== undefined) {
		checkFieldKey("DITERO_ENCRYPTION_KEY_NEXT", encryptionKeyNext);
	}

	const authUrl = absoluteHttpUrl(
		"BETTER_AUTH_URL",
		plainValue(env, "BETTER_AUTH_URL"),
		{
			required: true,
		},
	);
	const zeroUrl = absoluteHttpUrl(
		"PUBLIC_ZERO_URL",
		plainValue(env, "PUBLIC_ZERO_URL"),
		{
			required: true,
		},
	);

	const optional = {};
	const googleSecret = optionalSecret("GOOGLE_CLIENT_SECRET");
	if (googleSecret !== undefined) optional.GOOGLE_CLIENT_SECRET = googleSecret;
	if (encryptionKeyNext !== undefined) {
		optional.DITERO_ENCRYPTION_KEY_NEXT = encryptionKeyNext;
	}
	for (const name of PLAIN_SECRETS) {
		const value = plainValue(env, name);
		if (value !== undefined) optional[name] = value;
	}
	for (const name of PASSTHROUGH) {
		const value = plainValue(env, name);
		if (value !== undefined) optional[name] = value;
	}
	const attachments = attachmentEnv(env, optionalSecret);

	const home = (name) => ({ PATH: SERVICE_PATH, HOME: `${RUN}/${name}` });
	const services = {
		postgres: service("postgres", PG_UID, home("postgres")),
		roleInit: service(
			"role-init",
			PG_UID,
			{
				...home("role-init"),
				PGHOST: `${RUN}/postgres`,
				PGUSER: ADMIN_ROLE,
				PGDATABASE: "postgres",
				DITERO_MIGRATION_DB_PASSWORD: dbPasswords.DITERO_MIGRATION_DB_PASSWORD,
				DITERO_RUNTIME_DB_PASSWORD: dbPasswords.DITERO_RUNTIME_DB_PASSWORD,
				ZERO_DATABASE_PASSWORD: dbPasswords.ZERO_DATABASE_PASSWORD,
				DITERO_ZERO_SHARD_SCHEMA: DEFAULT_SHARD_SCHEMA,
			},
			{ freshOnly: true },
		),
		// Only the owner credential, and only until the migration finishes; the
		// graph must remove this envdir afterwards.
		migrate: service(
			"migrate",
			APP_UID,
			{
				...home("migrate"),
				NODE_ENV: "production",
				DATABASE_URL: dbUrl(
					MIGRATOR_ROLE,
					dbPasswords.DITERO_MIGRATION_DB_PASSWORD,
				),
			},
			{ ephemeral: true },
		),
		api: service("api", APP_UID, {
			...home("api"),
			NODE_ENV: "production",
			API_PORT,
			DATABASE_URL: dbUrl(RUNTIME_ROLE, dbPasswords.DITERO_RUNTIME_DB_PASSWORD),
			BETTER_AUTH_SECRET: authSecret,
			BETTER_AUTH_URL: authUrl,
			PUBLIC_ZERO_URL: zeroUrl,
			DITERO_ENCRYPTION_KEY: encryptionKey,
			DITERO_ZERO_SHARD_SCHEMA: DEFAULT_SHARD_SCHEMA,
			...optional,
			...attachments,
		}),
		zero: service("zero", ZERO_UID, {
			...home("zero"),
			PATH: `/opt/app/node_modules/.bin:${SERVICE_PATH}`,
			ZERO_IN_CONTAINER: "1",
			ZERO_LITESTREAM_CONFIG_PATH: "/etc/litestream.yml",
			ZERO_LITESTREAM_EXECUTABLE: "/usr/local/bin/litestream",
			ZERO_LITESTREAM_EXECUTABLE_V5: "/usr/local/bin/litestream-v5",
			ZERO_LOG_FORMAT: "json",
			ZERO_SERVER_VERSION: "1.9.0",
			ZERO_UPSTREAM_DB: dbUrl(ZERO_ROLE, dbPasswords.ZERO_DATABASE_PASSWORD),
			ZERO_CVR_DB: dbUrl(ZERO_ROLE, dbPasswords.ZERO_DATABASE_PASSWORD),
			ZERO_CHANGE_DB: dbUrl(ZERO_ROLE, dbPasswords.ZERO_DATABASE_PASSWORD),
			ZERO_REPLICA_FILE: `${ZERO_TOP}/replica.db`,
			ZERO_QUERY_URL: `http://127.0.0.1:${API_PORT}/api/zero/query`,
			ZERO_MUTATE_URL: `http://127.0.0.1:${API_PORT}/api/zero/mutate`,
			ZERO_ENABLE_CRUD_MUTATIONS: "false",
			ZERO_ADMIN_PASSWORD: zeroAdminPassword,
		}),
		// Read by healthcheck.sh through s6-envdir; the non-admin runtime role only.
		healthcheck: service("healthcheck", 0, {
			PGHOST: PG_HOST,
			PGPORT: String(PG_PORT),
			PGUSER: RUNTIME_ROLE,
			PGDATABASE: DATABASE,
			PGPASSWORD: dbPasswords.DITERO_RUNTIME_DB_PASSWORD,
			PGSSLMODE: "disable",
			PGCONNECT_TIMEOUT: "3",
			PGOPTIONS: "-c statement_timeout=3000",
			PGAPPNAME: "ditero-healthcheck",
		}),
	};

	const dirs = [
		{ path: RUN, mode: 0o711, uid: 0, gid: 0 },
		{ path: `${RUN}/bootstrap`, mode: 0o700, uid: 0, gid: 0 },
	];
	const files = [];
	for (const svc of Object.values(services)) {
		dirs.push(
			{ path: svc.dir, mode: 0o700, uid: svc.uid, gid: svc.gid },
			{
				path: svc.envDir,
				mode: 0o700,
				uid: svc.uid,
				gid: svc.gid,
				prune: true,
			},
		);
		for (const name of Object.keys(svc.env).sort()) {
			files.push({
				path: `${svc.envDir}/${name}`,
				mode: 0o600,
				uid: svc.uid,
				gid: svc.gid,
				content: `${svc.env[name]}\n`,
				when: svc.freshOnly ? "fresh" : "always",
			});
		}
	}
	const pgFile = (name, content, when = "always") => ({
		path: `${RUN}/postgres/${name}`,
		mode: 0o600,
		uid: PG_UID,
		gid: PG_UID,
		content,
		when,
	});
	files.push(
		pgFile("postgresql.conf", renderPostgresConf()),
		pgFile("pg_hba.conf", renderPgHba()),
		pgFile("pg_ident.conf", renderPgIdent()),
		// Consumed by initdb --pwfile as the postgres UID, then removed.
		pgFile("initdb-password", `${dbPasswords.POSTGRES_PASSWORD}\n`, "fresh"),
		{
			path: `${RUN}/role-init/role-init.sql`,
			mode: 0o600,
			uid: PG_UID,
			gid: PG_UID,
			content: roleBootstrapSql(),
			when: "fresh",
		},
	);

	return deepFreeze({
		attachmentDriver: attachments.DITERO_ATTACHMENT_STORAGE_DRIVER,
		services,
		dirs,
		files,
	});
}

// ---- volume and cluster state (pure) --------------------------------------

// snapshot: { exists, type: "dir"|"symlink"|"file"|"other", uid, mode, entries }
// Decides whether a volume top directory is a proven-empty fresh volume (and
// whether it must be adopted, i.e. chown'ed to the service UID and chmod'ed
// 0700) or holds existing data that is already owned and private. Never
// authorises changing ownership of anything non-empty.
export function validateVolumeTopdir(snapshot, { name, uid }) {
	if (!snapshot?.exists) fail(`${name} volume mount point is missing`);
	if (snapshot.type !== "dir") {
		fail(`${name} volume mount point must be a real directory`);
	}
	if (snapshot.entries.length === 0) {
		if (snapshot.uid !== 0 && snapshot.uid !== uid) {
			fail(`${name} volume is empty but owned by an unexpected uid`);
		}
		return {
			fresh: true,
			adopt: snapshot.uid !== uid || snapshot.mode !== 0o700,
		};
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

function removeIfExists(path) {
	try {
		unlinkSync(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}

// Creates a missing directory with its final owner and mode; an existing one
// must already match exactly (never repaired, never followed through a symlink).
function ensureDir({ path, mode, uid, gid }) {
	const snap = snapshotPath(path);
	if (!snap.exists) {
		mkdirSync(path, { mode: 0o700 });
		chownSync(path, uid, gid);
		chmodSync(path, mode);
		return;
	}
	if (snap.type !== "dir" || snap.uid !== uid || snap.mode !== mode) {
		fail(`runtime directory ${path} has unexpected type, owner or mode`);
	}
}

function pruneDir(path, keep) {
	for (const name of readdirSync(path)) {
		if (keep.has(name)) continue;
		const entry = `${path}/${name}`;
		if (!lstatSync(entry).isFile())
			fail(`unexpected non-file entry in ${path}`);
		unlinkSync(entry);
	}
}

// Stage in the destination directory with O_EXCL|O_NOFOLLOW, set owner and
// mode before any content is written, then rename into place.
function writeFileAtomic({ path, mode, uid, gid, content }) {
	const tmp = `${path}.tmp`;
	removeIfExists(tmp);
	const fd = openSync(
		tmp,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		fchownSync(fd, uid, gid);
		fchmodSync(fd, mode);
		writeFileSync(fd, content);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		removeIfExists(tmp);
		throw error;
	}
	closeSync(fd);
	renameSync(tmp, path);
}

// Only ever applied to a topdir that validateVolumeTopdir proved empty;
// re-checked on the open descriptor right before the change.
function adoptEmptyDir(path, uid) {
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const st = fstatSync(fd);
		if (
			!st.isDirectory() ||
			(st.uid !== 0 && st.uid !== uid) ||
			readdirSync(path).length !== 0
		) {
			fail("volume changed while it was being prepared");
		}
		fchownSync(fd, uid, uid);
		fchmodSync(fd, 0o700);
	} finally {
		closeSync(fd);
	}
}

function prepare(env) {
	// Invalidate transient authority before validation, including failed restarts.
	ensureDir({ path: RUN, uid: 0, gid: 0, mode: 0o711 });
	ensureDir({ path: `${RUN}/bootstrap`, uid: 0, gid: 0, mode: 0o700 });
	removeIfExists(`${RUN}/ready`);
	removeIfExists(CLUSTER_STATE_FILE);
	// 1. Validate everything; no writes yet.
	const config = buildConfiguration(env);
	const cluster = validateClusterState(snapshotCluster());
	const zero = validateVolumeTopdir(snapshotPath(ZERO_TOP), {
		name: "zero",
		uid: ZERO_UID,
	});
	const attachments = validateVolumeTopdir(snapshotPath(ATTACHMENTS_TOP), {
		name: "attachments",
		uid: APP_UID,
	});
	if (snapshotPath("/run").type !== "dir") fail("/run is not a directory");
	const fresh = cluster.action === "init";

	// 2. Stage /run.
	for (const dir of config.dirs) ensureDir(dir);
	removeIfExists(CLUSTER_STATE_FILE);
	const wanted = config.files.filter((file) => fresh || file.when === "always");
	for (const dir of config.dirs.filter((entry) => entry.prune)) {
		const keep = new Set(
			wanted
				.filter(
					(file) => file.path.slice(0, file.path.lastIndexOf("/")) === dir.path,
				)
				.map((file) => file.path.slice(file.path.lastIndexOf("/") + 1)),
		);
		pruneDir(dir.path, keep);
	}
	for (const file of config.files) {
		if (fresh || file.when === "always") writeFileAtomic(file);
		else removeIfExists(file.path);
	}

	// 3. Adopt proven-empty fresh volumes.
	if (cluster.adoptTopdir) adoptEmptyDir(PG_TOP, PG_UID);
	if (zero.adopt) adoptEmptyDir(ZERO_TOP, ZERO_UID);
	if (attachments.adopt) adoptEmptyDir(ATTACHMENTS_TOP, APP_UID);

	// 4. Decision record last, so its presence means everything above finished.
	writeFileAtomic({
		path: CLUSTER_STATE_FILE,
		mode: 0o600,
		uid: 0,
		gid: 0,
		content: `${cluster.action}\n`,
	});
}

function main(argv) {
	if (argv.length !== 1 || argv[0] !== "prepare") {
		process.stderr.write("usage: config.mjs prepare\n");
		return 2;
	}
	try {
		prepare(process.env);
		return 0;
	} catch (error) {
		const detail =
			error instanceof ConfigError
				? error.message
				: `unexpected failure${error?.code ? ` (${error.code})` : ""}`;
		process.stderr.write(`ditero: ${detail}\n`);
		return 1;
	}
}

if (
	process.argv[1] !== undefined &&
	process.argv[1] !== "-" &&
	fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
	process.exitCode = main(process.argv.slice(2));
}
