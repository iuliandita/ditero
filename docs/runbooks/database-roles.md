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

Set `DITERO_MIGRATION_DATABASE_URL` to the owner DSN and `DITERO_DATABASE_URL` to the runtime DSN. Configure `DITERO_ZERO_DATABASE_URL` according to the Zero deployment guide and provider replication controls. Never point application runtime traffic at the migration or Zero login.

After migration, verify `user_secret` has both row security flags and that the runtime role cannot read it without `SET LOCAL ditero.user_id`.
