CREATE TABLE relay_installation (
 id text PRIMARY KEY, device_key jsonb NOT NULL, device_thumbprint text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE relay_target (
 id text PRIMARY KEY, installation_id text NOT NULL REFERENCES relay_installation(id),
 registration_id text NOT NULL, offer_id text NOT NULL UNIQUE, offer_expires timestamptz NOT NULL,
 sender_key jsonb NOT NULL, sender_thumbprint text NOT NULL, send_hash text NOT NULL,
 management_hash text NOT NULL, credential_version integer NOT NULL DEFAULT 1,
 generation integer NOT NULL DEFAULT 1, state text NOT NULL CHECK(state IN ('issued','confirmed','retired')),
 fid_encrypted text NOT NULL, challenge_encrypted text,
 pending_fid text, pending_management_hash text, pending_challenge text,
 pending_expires timestamptz, pending_operation_id text,
 receipt text, retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_target_installation ON relay_target(installation_id);
CREATE TABLE relay_operation (
 id text PRIMARY KEY, installation_id text NOT NULL REFERENCES relay_installation(id),
 target_id text NOT NULL REFERENCES relay_target(id), path text NOT NULL, digest text NOT NULL,
 authority_hash text NOT NULL, outcome jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relay_operation_target ON relay_operation(target_id,created_at);
CREATE TABLE relay_nonce (
 key_thumbprint text NOT NULL, nonce text NOT NULL, operation_id text NOT NULL,
 digest text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(key_thumbprint, nonce)
);
CREATE TABLE relay_quota (
 key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL CHECK(count > 0)
);
CREATE TABLE relay_schema_version (version integer PRIMARY KEY);
INSERT INTO relay_schema_version VALUES (1);
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
