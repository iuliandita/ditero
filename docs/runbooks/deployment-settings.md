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
channel image labels; release workflows supply them from the checked source and
release version. The app and Zero images also bake the commit into the
`DITERO_GIT_SHA` environment variable, which the app reports as `revision` in
`/health` and the Kustomize Zero init container compares. Do not set it in
deployment configuration. A build without it reports `revision: null`.

Compose defaults `DITERO_IMAGE_TAG` to `0.1.0-beta.4` for the app and defaults Zero to that tag with
`-zero` appended. For a commit-pinned nightly pair, set both `DITERO_IMAGE_TAG`
and `DITERO_ZERO_IMAGE_TAG`: for example, `nightly-<commit>` and
`nightly-zero-<commit>`. Release pairs keep the default suffix convention.
Always select matching app and Zero revisions; changing either tag does not
restore a database or roll back its migrations.

Run source deployments with `NODE_ENV=production`, as the shipped images do.
Production startup requires `BETTER_AUTH_URL` or `DITERO_PUBLIC_URL` as an HTTP
or HTTPS origin without credentials, a path, a query or a fragment.
Empty values are treated as unset. The all-in-one wrapper applies the same origin
validation. `BETTER_AUTH_URL` takes precedence for auth; otherwise auth uses
`DITERO_PUBLIC_URL`. Outside production, the default is `http://localhost:3000`.
The request Host never chooses the auth origin. A soft-deleted account still
counts toward bootstrap registration, so deleting the first account does not
reopen registration. If the sole owner deleted their account, an operator can
temporarily set `DITERO_REGISTRATION_MODE=open`, restart, register the replacement
owner, then restore `DITERO_REGISTRATION_MODE=bootstrap` and restart. Keep access
restricted during that recovery window.

Auth rate-limit relaxation requires both `NODE_ENV=test` and `DITERO_E2E=1`.
Password-reset mail shares a recipient budget across client IPs: three messages
initially, with one token replenished every 100 seconds. Exhausting that budget
suppresses mail without changing the uniform successful response for known and
unknown addresses. Origin, body and per-IP checks run before charging it. Budget
checks and mail delivery remain detached from the request; recipient keys are
normalized and hashed.

## Email invitation confirmation

Configure `DITERO_SMTP_HOST` and a public URL before requiring mailbox confirmation
for email-bound invitations. A configured but broken SMTP service blocks unverified
invitees from joining; repair delivery and check auth-mail logs. Account sign-in
and global optional email verification remain unchanged.

Without SMTP, an invitation token plus a matching account address grants the role.
The server cannot prove mailbox ownership, so a leaked invitation link can grant
its role to someone who registers that address. Share links privately. See the
[invitation procedure](native-authentication.md#email-invitation-confirmation) for
confirmation links, expiry, resend limits, and Android/desktop browser handling.
