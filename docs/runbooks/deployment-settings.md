# Deployment setting aliases

Compose maps the following file settings to the application or Zero entrypoint.
Each path must name a nonempty readable file inside the corresponding container;
mount the file through your deployment's secret mechanism. Do not set both a
literal value and its file variant. Restart the affected service after changing
its environment or secret mount. These names do not create or mount secrets.

| Compose setting | Container setting | Purpose |
| --- | --- | --- |
| `DITERO_DATABASE_URL_FILE` | `DATABASE_URL_FILE` | Runtime application database connection. |
| `DITERO_MIGRATION_DATABASE_URL_FILE` | `DATABASE_MIGRATION_URL_FILE` | Migration-owner database connection. |
| `DITERO_ZERO_DATABASE_URL_FILE` | `ZERO_UPSTREAM_DB_FILE`, `ZERO_CVR_DB_FILE`, `ZERO_CHANGE_DB_FILE` | Direct Zero database connection. |
| `DITERO_RUNTIME_DB_PASSWORD_FILE` | `DITERO_RUNTIME_DB_PASSWORD_FILE` | Bundled runtime-role password used by initialization and the app entrypoint. |
| `DITERO_MIGRATION_DB_PASSWORD_FILE` | `DITERO_MIGRATION_DB_PASSWORD_FILE` | Bundled migration-role password used by initialization and the app entrypoint. |
| `DITERO_ENCRYPTION_KEY_NEXT_FILE` | `DITERO_ENCRYPTION_KEY_NEXT_FILE` | Next server field-encryption key during an operator-planned rotation. |

Retain the existing database roles and encryption keys during recovery. Changing
password inputs does not rotate an already initialized PostgreSQL role. Follow
the [database role procedure](database-roles.md) and
[credential encryption procedure](encryption.md) rather than replacing
existing values to repair a failed startup.

Kustomize uses `DITERO_APP_SERVICE` inside the Zero Deployment to expand its query
and mutation endpoint URLs. Keep it consistent with the rendered application
Service name when overlays add a name prefix or suffix. This is an internal
service reference, not the browser's public Zero URL.

`DITERO_GIT_SHA` and `DITERO_CHANNEL` are Docker build arguments for source and
channel image labels. They are build metadata, not runtime application settings;
release workflows supply them from the checked source and release version.
