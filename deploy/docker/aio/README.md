# Experimental all-in-one image

This optional image runs PostgreSQL 18, Ditero and Zero under s6-overlay.
It is a source candidate, not a published or fully qualified deployment option.
The existing separate-service Compose and Helm deployments remain unchanged.

## Build

Build from the repository root. `ZERO_RUNTIME_IMAGE` must identify a qualified
Ditero Zero runtime on Alpine 3.24.2 by immutable digest, including its Node,
Zero, Litestream and runtime-verification assets. An arbitrary upstream Zero
image is not interchangeable. Supply that public image reference yourself:

```sh
docker build --platform linux/amd64 \
  --file deploy/docker/Dockerfile.all-in-one \
  --build-arg ZERO_RUNTIME_IMAGE="$ZERO_RUNTIME_IMAGE" \
  --build-arg DITERO_GIT_SHA="$(git rev-parse HEAD)" \
  --build-arg DITERO_CHANNEL=experimental \
  --tag ditero-all-in-one:experimental .
```

The Dockerfile pins the Bun builder. The package lock pins 26 Alpine packages
per architecture and two signing keys; the fetcher verifies artifact hashes,
and APK installation verifies package signatures without repository resolution.
Supervisor archives are pinned separately. A retained amd64 build executed the
normal fetcher and rebuilt every application/runtime stage successfully. That
evidence belongs to its earlier source and image; it does not qualify this new
public head. arm64 build/runtime still require qualification.

## Configuration

Prepare a private `aio.env` outside the build context with mode0600 and a
private parent directory. Set these required values through the file, never
through command-line secret arguments:

```dotenv
POSTGRES_PASSWORD=<unique database-admin password>
DITERO_MIGRATION_DB_PASSWORD=<different migration password>
DITERO_RUNTIME_DB_PASSWORD=<different application password>
ZERO_DATABASE_PASSWORD=<different replication password>
ZERO_ADMIN_PASSWORD=<Zero administration password>
BETTER_AUTH_SECRET=<retained authentication secret>
DITERO_ENCRYPTION_KEY=<canonical base64 encoding of 32 random bytes>
BETTER_AUTH_URL=http://localhost:3000
PUBLIC_ZERO_URL=http://localhost:4848
```

Replace every placeholder. The four database passwords must differ. Keep the
original authentication secret, encryption keys and database credentials for
retained data; startup does not authorize generating recovery replacements.
The two URLs must match the browser's actual origins. For remote access, use
HTTPS through an operator-configured reverse proxy.

The API port, production mode and Zero shard are fixed at 3000, production and
`zero_0`. Database connections are direct, local connections; PostgreSQL uses
logical WAL and SCRAM authentication. The migrator owns application schema DDL;
the application role is nonsuperuser and NOBYPASSRLS. Zero uses a dedicated
database superuser for its replication/schema lifecycle. Do not inject `DATABASE_URL`, arbitrary Zero settings or test
seams. For externally managed PostgreSQL and standalone Zero, use the existing
[database role runbook](../../../docs/runbooks/database-roles.md) and standard
deployment packages instead.

Required secrets also accept corresponding `_FILE` settings, with direct/file
conflicts refused. These require absolute, nonsymlink, root-owned files and a
root-only parent directory inside the container; unsafe metadata is refused.
This interface has not received complete packaged runtime qualification. The
example below uses the supported environment-file path.

## Local startup

Choose fresh empty volume names for a new installation. These three volumes
must remain separate and retained. Existing data is reused only with the
expected ownership, PostgreSQL major and completed initialization marker;
unknown, partially initialized or incompatible data is refused.

```sh
docker run --detach --name ditero-aio \
  --env-file ./aio.env \
  --read-only --security-opt no-new-privileges \
  --cap-drop ALL \
  --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add KILL --cap-add SETGID --cap-add SETUID \
  --tmpfs /run:rw,exec,nosuid,nodev,size=128m,mode=755 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777 \
  --mount type=volume,src=ditero-aio-pg18,dst=/var/lib/ditero/pg18,volume-nocopy \
  --mount type=volume,src=ditero-aio-zero,dst=/var/lib/ditero/zero,volume-nocopy \
  --mount type=volume,src=ditero-aio-attachments,dst=/var/lib/ditero/attachments,volume-nocopy \
  --publish 127.0.0.1:3000:3000 --publish 127.0.0.1:4848:4848 \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 512 \
  --log-driver local --log-opt max-size=10m --log-opt max-file=2 \
  ditero-all-in-one:experimental
```

PID1 and bootstrap run as root for ownership and service transitions. Application,
PostgreSQL and Zero run as distinct UIDs 1000, 1001 and 1002. Do not force the
container itself to a nonroot user or mount the Docker socket. PostgreSQL's
port is internal and is not published. `/run` must permit execution for the
supervisor; `/tmp` and the three data mounts supply the remaining writable paths.

Wait for combined health before using the application. The healthcheck requires
the graph's readiness marker, the expected database identity, API health and
Zero keepalive. Docker health status itself does not block published traffic.
Startup applies migrations under one session's advisory lock. Do not run the
ordinary migration entrypoint concurrently; it does not share this lock.
Stop the container normally and retain all three volumes and original secrets.

## Qualification limits

Private amd64 images have passed fresh first boot, journal81, service identity,
combined health and clean shutdown checks. That evidence predates this public
source integration and does not establish a new public-head runtime pass.
Authenticated shared-workspace and extracted-client journeys are still being
qualified. Complete arm64, strict file credentials,
failure propagation, secret isolation and encrypted backup/restore qualification
remain open. There is no release/publication or complete-support claim.
