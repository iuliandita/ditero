# Litestream dependency builds

The Dockerfile rebuilds the exact sources shipped by Zero 1.9.0:

- Legacy: Rocicorp `zero@v0.0.9`, commit `5efae7df64aebc3247a739360232f908d2bc47e2`.
- V5: Litestream `v0.5.15`, commit `4e3f0c0f98a8808788c721b3637b41e7f9ce4a9c`.

Archive checksums and Go 1.26.8 are pinned in the Dockerfile. Each directory contains
replacement Go module manifests and checksums, generated from that source with:

```sh
go get golang.org/x/crypto@v0.56.0 google.golang.org/grpc@v1.83.2
# Legacy only:
go get filippo.io/age@v1.2.1
go mod tidy
```

The remaining module upgrades follow those packages' minimum requirements. Builds
use `-mod=readonly`; no upstream application source is patched. The `-ditero.1`
version suffix identifies the dependency rebuild. Keep both binaries: the legacy
fork supplies Zero's watermark integration and V5 restores the newer LTX format.

Run `tests/container/zero.sh` after changes. Its backup check verifies database
contents and integrity across legacy-to-legacy, legacy-to-V5, and V5-to-V5 restores,
including writes made after the initial backup. Scan the resulting
`ditero-zero-smoke` image without ignoring vulnerabilities before publishing.

Trivy also reports GO-2026-5932 for `golang.org/x/crypto` at module level.
That advisory covers the abandoned `openpgp` package; neither binary imports it.
Verify this with `go list -deps ./cmd/litestream` in each source tree. Keep the
finding visible rather than adding a module-wide scanner exception.
