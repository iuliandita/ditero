# External Database Roles

Configure verified connections using the [database TLS guide](database-tls.md);
private CA configuration differs between the application and Zero.

PostgreSQL 15 or newer is required. Use `wal_level=logical`, sufficient replication
slots/WAL senders, and direct connections. The bundled stack uses PostgreSQL 18.

Use three database logins:

- A migration owner that owns the database schema but is not a superuser.
- A runtime login with DML privileges but no ownership, superuser, owner membership, or `BYPASSRLS`.
- A direct Zero login with the replication and schema privileges required by Zero.

Create the owner and runtime roles before the first migration. As a database administrator, adapt and run:

```sql
create role ditero_migrator login password 'replace-me'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
create role ditero_runtime login password 'replace-me'
  nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

alter database ditero owner to ditero_migrator;
alter schema public owner to ditero_migrator;
grant connect on database ditero to ditero_runtime;
grant usage on schema public to ditero_runtime;
alter default privileges for role ditero_migrator in schema public
  grant select, insert, update, delete on tables to ditero_runtime;
alter default privileges for role ditero_migrator in schema public
  grant usage, select, update on sequences to ditero_runtime;
```

## Non-superuser Zero login and publication

As an administrator connected to the `ditero` database, create a dedicated Zero
login before starting Zero:

```sql
create role ditero_zero login password 'replace-me'
  nosuperuser nocreatedb nocreaterole noinherit replication bypassrls;
grant connect, create on database ditero to ditero_zero;
grant usage on schema public to ditero_zero;
grant select on all tables in schema public to ditero_zero;
alter default privileges for role ditero_migrator in schema public
  grant select on tables to ditero_zero;

create publication ditero_public for tables in schema public
  with (publish_via_partition_root = true);
```

The schema publication requires an administrator/superuser and includes future
tables in `public`. Zero creates its own internal publication and CDC/CVR schemas;
database `CREATE` permits that lifecycle. `REPLICATION` permits logical decoding
and `BYPASSRLS` permits complete initial snapshots. This is a privileged service
login, never the application runtime login or a browser credential. Providers must
allow these attributes and logical replication; ordinary database ownership alone
does not grant them.

Create the shard and grants below before the first Zero start. Then set
`DITERO_ZERO_DATABASE_URL` to this login's percent-encoded DSN and configure:

```sh
ZERO_APP_PUBLICATIONS=ditero_public
ZERO_AUTO_RESET=true
```

Compose forwards both settings; empty values are treated as unset. For Helm, add
them to `zero.extraEnv` as string values. Automatic reset rebuilds the disposable
Zero replica when replication/schema changes require it. It does not replace
PostgreSQL backups or guarantee repair of every failed initial sync.

Run application migrations and wait for app `/health` before starting Zero.
Without superuser DDL event triggers, Zero uses degraded schema-change detection;
keep automatic reset enabled and verify fresh-client sync after migrations.

## Zero's shard schema

zero-cache stores per-client sync bookkeeping in a shard schema (`zero_0` by default) that it creates on first boot, owned by the role it connects as. Both application roles need access to it:

- The runtime role writes each client's `lastMutationID` there inside the mutation's own transaction. Without access, the stack reports every container healthy and then fails **every** mutation with `permission denied for schema zero_0`.
- The migration role triggers Zero's DDL event trigger whenever a migration runs, and that trigger executes as the role issuing the DDL.

Grant both roles before the first boot. Create the schema yourself so the default privileges can be scoped to it, since zero-cache creates its tables later:

```sql
create schema zero_0 authorization ditero_zero;
grant usage on schema zero_0 to ditero_runtime, ditero_migrator;
alter default privileges for role ditero_zero in schema zero_0
  grant select, insert, update, delete on tables to ditero_runtime, ditero_migrator;
alter default privileges for role ditero_zero in schema zero_0
  grant usage, select, update on sequences to ditero_runtime, ditero_migrator;
```

Run these as an administrator. Default privileges apply to objects created by
`ditero_zero`, including its future shard tables; existing tables need equivalent
explicit DML grants. If zero-cache uses a non-default app id, substitute its schema
name here and set `DITERO_ZERO_SHARD_SCHEMA` to match, or the application's boot
check looks at the wrong schema.

The application verifies this at startup in production and refuses to boot if the schema exists but is unreachable. A schema that does not exist yet is accepted: on a first boot the application can win the race against zero-cache creating it.

Set `DITERO_MIGRATION_DATABASE_URL` to the owner DSN and `DITERO_DATABASE_URL` to the runtime DSN. Never point application runtime traffic at the migration or Zero login.

After migration, verify `user_secret` has both row security flags and that the runtime role cannot read it without `SET LOCAL ditero.user_id`.

## Superuser Zero alternative

On a dedicated database, Zero can instead connect as an administrator/superuser
(the bundled stack uses `postgres`). Leave `ZERO_APP_PUBLICATIONS` unset so Zero
manages its default publication and DDL event triggers. Precreate `zero_0` owned
by that Zero login and use `ALTER DEFAULT PRIVILEGES FOR ROLE` with that login in
the shard recipe above. Keep runtime/migration shard DML grants scoped to `zero_0`,
excluding Zero's CDC/CVR internals. The app runtime must remain a separate
`NOSUPERUSER NOBYPASSRLS` role.

See [Zero's PostgreSQL guide](https://zero.rocicorp.dev/docs/connecting-to-postgres)
for upstream details; managed providers may impose additional replication limits.
