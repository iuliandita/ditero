# Litestream dependency builds

The Dockerfile rebuilds the exact sources shipped by Zero 1.11.1:

- Legacy: Rocicorp `v0.3.13-zero.11`, commit `f82952e1b377d94199b0979081a5679dad1e0f3d`.
- V5: Rocicorp `v0.5.18-zero.16`, commit `f4438c26c2d800fa7f2b952ab7b0e11232c194a9`.

Archive checksums and the Go 1.27.3 toolchain are pinned in the Dockerfile. Each directory contains
replacement Go module manifests and checksums, generated from that source with:

```sh
go get golang.org/x/crypto@v0.57.0 google.golang.org/grpc@v1.83.2
go get go.opentelemetry.io/otel/sdk@v1.45.0
# Legacy only:
go get filippo.io/age@v1.2.1
# Both variants:
go get golang.org/x/net@v0.60.0
# V5 only:
go get github.com/klauspost/compress@v1.18.7
go mod tidy
```

The remaining module upgrades follow those packages' minimum requirements. Builds
use `-mod=readonly`; no upstream application source is patched. The `-ditero.1`
version suffix identifies the dependency rebuild. Keep both binaries: the legacy
fork supplies Zero's watermark integration and V5 restores the newer LTX format.

The V5 configuration ships beside the legacy configuration; Zero 1.11 selects
V5 by default. Existing legacy backups remain readable by the V5 restore path.

Run `tests/container/zero.sh` after changes. Its backup check verifies database
contents and integrity across legacy-to-legacy, legacy-to-V5, and V5-to-V5 restores,
including writes made after the initial backup. Scan the resulting
`ditero-zero-smoke` image without ignoring vulnerabilities before publishing.

Trivy also reports GO-2026-5932 for `golang.org/x/crypto` at module level.
That advisory covers the abandoned `openpgp` package; neither binary imports it.
Verify this with `go list -deps ./cmd/litestream` in each source tree. Keep the
finding visible rather than adding a module-wide scanner exception.
