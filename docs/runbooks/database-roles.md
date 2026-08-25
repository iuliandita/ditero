# External Database Roles

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

## Zero's shard schema

zero-cache stores per-client sync bookkeeping in a shard schema (`zero_0` by default) that it creates on first boot, owned by the role it connects as. Both application roles need access to it:

- The runtime role writes each client's `lastMutationID` there inside the mutation's own transaction. Without access, the stack reports every container healthy and then fails **every** mutation with `permission denied for schema zero_0`.
- The migration role triggers Zero's DDL event trigger whenever a migration runs, and that trigger executes as the role issuing the DDL.

Grant both roles before the first boot. Create the schema yourself so the default privileges can be scoped to it, since zero-cache creates its tables later:

```sql
create schema zero_0;
grant usage on schema zero_0 to ditero_runtime, ditero_migrator;
alter default privileges in schema zero_0
  grant select, insert, update, delete on tables to ditero_runtime, ditero_migrator;
alter default privileges in schema zero_0
  grant usage, select, update on sequences to ditero_runtime, ditero_migrator;
```

Run these as the role zero-cache connects as: `alter default privileges` without `for role` applies only to objects that role goes on to create. If zero-cache uses a non-default app id, substitute its schema name here and set `DITERO_ZERO_SHARD_SCHEMA` to match, or the application's boot check looks at the wrong schema.

The application verifies this at startup in production and refuses to boot if the schema exists but is unreachable. A schema that does not exist yet is accepted: on a first boot the application can win the race against zero-cache creating it.

Set `DITERO_MIGRATION_DATABASE_URL` to the owner DSN and `DITERO_DATABASE_URL` to the runtime DSN. Configure `DITERO_ZERO_DATABASE_URL` according to the Zero deployment guide and provider replication controls. Never point application runtime traffic at the migration or Zero login.

After migration, verify `user_secret` has both row security flags and that the runtime role cannot read it without `SET LOCAL ditero.user_id`.
