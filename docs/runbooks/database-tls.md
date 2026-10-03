# PostgreSQL TLS

Use a direct PostgreSQL hostname covered by the server certificate's SANs. Keep
certificate and hostname verification enabled for runtime, migration and Zero
connections. Browser HTTPS and PostgreSQL TLS are separate connections.

## Private certificate authorities

Mount the trusted CA certificate bundle as a read-only PEM file in each component
that connects to PostgreSQL. The container's nonroot user must be able to read it.
Mount certificates only; a server private key does not belong in these clients.

The application and Zero use different PostgreSQL clients:

| Secret key | Verified private-CA configuration |
| --- | --- |
| `DATABASE_URL` | Runtime DSN with `sslmode=verify-full` and `sslrootcert=/run/database-ca/ca.crt` |
| `DATABASE_MIGRATION_URL` | Migration DSN with the same TLS parameters |
| `ZERO_UPSTREAM_DB` | Zero DSN with `sslmode=verify-full`, without `sslrootcert`; set `NODE_EXTRA_CA_CERTS=/run/database-ca/ca.crt` in Zero's environment |

The application uses node-postgres. Zero's postgres.js client does not interpret
`sslrootcert` as a CA-file option: it forwards it as a PostgreSQL startup parameter,
which the server rejects. Copying the application's DSN parameters to Zero can
first fail certificate trust and then fail with `unrecognized configuration
parameter "sslrootcert"`. Configure both the Zero environment and its DSN.

Node reads `NODE_EXTRA_CA_CERTS` when the process starts. Changing a projected
Secret or environment value does not update an existing process's trust store.
Roll out the affected Deployments after CA or credential changes. Keep the old
and new trusted CA certificates during a planned rotation when required by the
database operator. Do not disable verification to resolve trust failures.

## Kubernetes mounts

Provision an existing `ditero-database-ca` Secret with the trusted PEM bundle in
its `ca.crt` key. In an operator Kustomize overlay, add these strategic merge
patches as separate `patches` entries. Keep the normal deployment base, namespace,
image pins and application configuration in that overlay.

```yaml
patches:
- path: database-app-ca.yaml
  target:
    kind: Deployment
    name: ditero-app
- path: database-zero-ca.yaml
  target:
    kind: Deployment
    name: ditero-zero
```

Save the following patches in the corresponding files. Explicit targets also
match resources whose namespace was already set by the base.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ditero-app
spec:
  template:
    spec:
      containers:
      - name: app
        volumeMounts:
        - name: database-ca
          mountPath: /run/database-ca
          readOnly: true
      volumes:
      - name: database-ca
        secret:
          secretName: ditero-database-ca
          items:
          - key: ca.crt
            path: ca.crt
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ditero-zero
spec:
  template:
    spec:
      containers:
      - name: zero
        env:
        - name: NODE_EXTRA_CA_CERTS
          value: /run/database-ca/ca.crt
        volumeMounts:
        - name: database-ca
          mountPath: /run/database-ca
          readOnly: true
      volumes:
      - name: database-ca
        secret:
          secretName: ditero-database-ca
          items:
          - key: ca.crt
            path: ca.crt
```

For Helm, `zero.extraEnv` can supply `NODE_EXTRA_CA_CERTS`. A maintained
post-renderer or operator overlay must also add the CA volume and mount to app
and Zero; setting the environment variable alone does not provide the file.
CloudNativePG operators must project their actual server CA and use the generated
read/write Service hostname in the DSNs.

## Qualification

Verify the rendered mounts, environment, Secret references and SAN hostname before
deployment. Then exercise application migrations and runtime DML, Zero logical
replication and an actual synchronized mutation. Prove that a connection with an
untrusted CA is rejected. Container health alone does not establish these checks.
Keep credentials and secret-bearing diagnostics in protected operator files.

References: [node-postgres TLS configuration](https://node-postgres.com/features/ssl),
[Node extra CA certificates](https://nodejs.org/api/cli.html#node_extra_ca_certsfile).
