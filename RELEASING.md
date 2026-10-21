# Releasing

Ditero builds server containers and native clients from one release commit. Development
happens on `develop`; `0.x.y` releases are prereleases. Stable `1.x.y` releases come
from `main`. Every change lands through a PR.

`0.1.0-beta.1` is the first beta being prepared. Beta remains a `0.x` prerelease
with breaking changes possible, not a stable release. Until publication completes,
use the [latest published downloads](https://github.com/iuliandita/ditero/releases).

## Build artifacts

Every push and PR builds Android development APKs and unsigned or ad-hoc desktop
installers. These test artifacts expire after seven days. Release packaging checks
also retain Helm, Kustomize and Compose packages for 30 days. The same checks build
the terminal client bundles, verify their identity, checksums and third-party
notices, and run them against a real database on the newest and the minimum
supported Bun (`MINIMUM_BUN` in `src/clients/build-info.ts`).

Tagged releases include:

- Alpine and Debian app containers and the Zero container, for amd64 and arm64,
  at `ghcr.io/iuliandita/ditero` and `docker.io/iuliandita/ditero`.
- Container signatures, provenance and SPDX SBOMs, plus immutable image digest files.
- Helm and Kustomize packages for app and Zero with external PostgreSQL, and a
  Compose archive containing the bundled PostgreSQL initialization scripts.
- Linux x86_64 DEB, RPM and AppImage; unsigned Windows x86_64 and ARM64 NSIS
  installers; separate ad-hoc signed macOS Apple Silicon and Intel DMGs.
- A signed independent Android universal APK and AAB. This flavor uses UnifiedPush;
  Google delivery requires separate private configuration and is not packaged here.
- `ditero-VERSION-clients.tar.gz`: the CLI, stdio MCP server and TUI as JavaScript
  bundles for a user-installed Bun, with `THIRD_PARTY_NOTICES.txt` and a `SHA256SUMS`
  file inside. The archive has no separate signature file; its keyless-signed build
  provenance attestation is stored with GitHub (`gh attestation verify`, with the
  command in the release notes). Publication rejects an archive missing a bundle, its
  checksum or the notices, and rejects a missing or mismatched attestation.
  Standalone executables are not published; see the [roadmap](docs/ROADMAP.md).
- `SHA256SUMS.txt` covering every download.

The development-installer and release workflows use the same five native targets:
Ubuntu 24.04 x64, Windows x64/ARM64, and macOS Apple Silicon/Intel. Linux ARM64
installers are not built. Native lifecycle tests use the same explicit Rust target
as packaging, retaining the test gate without compiling its dependencies twice.
Linux packages include AppStream metadata, a desktop
entry and the MIT license. They require a compatible system WebKitGTK 4.1/GTK 3;
the Ubuntu 24.04 build baseline is not a promise of compatibility with older Linux.
RPM metadata requires the GLIBC 2.39 symbol capability rather than a dependency
name containing a version expression.

Installer smoke checks extract Linux payloads with package tools (libarchive for
RPM), verify contents and x64 architecture, install
the DEB with dependency resolution, and install/verify the RPM in a pinned Fedora
44 container, checking linked libraries. DEB, extracted RPM and AppImage payloads
launch under Xvfb on Ubuntu; Fedora graphical startup remains unqualified.
Windows checks silently install NSIS, compare the installed
executable to the build, verify its PE architecture and require a Ditero window.
macOS checks mount the DMG, copy its app, verify the architecture and ad-hoc
signature, then require the process to survive startup. These checks do not
exercise sign-in, credential storage, upgrades or download trust warnings.
Per-format updater binary patching is disabled so the installed Windows executable
matches the build byte for byte; automatic updates are not configured.
Development downloads include a per-platform `SHA256SUMS.txt`; release checksums
and provenance continue to cover the complete release asset set.

Windows installers have no trusted publisher signature. macOS downloads have ad-hoc
signatures and are not notarized. Native device/platform qualification, general deep
links and automatic updates remain incomplete; a beta package does not establish
those behaviors. See the [Android](apps/android/README.md) and
[desktop](apps/desktop/README.md) qualification notes before testing.

## Channels

| Image tag | Meaning |
| --- | --- |
| `nightly`, `nightly-<sha>` | Every merge to `develop`; experimental |
| `0.0.1-alpha.1` | Immutable first alpha version |
| `0.0.1-alpha.2` | Second alpha version |
| `0.0.1-alpha.3` | Third alpha version |
| `0.0.1-alpha.4` | Fourth alpha version |
| `0.0.1-alpha.5` | Fifth alpha version |
| `0.0.1-alpha.6` | Sixth alpha version |
| `0.0.1-alpha.7` | Seventh alpha version |
| `0.0.1-alpha.8` | Eighth alpha version |
| `0.0.1-alpha.9` | Ninth alpha version |
| `0.0.1-alpha.10` | Tenth alpha version |
| `0.0.1-alpha.11` | Eleventh alpha version |
| `0.0.1-alpha.12` | Twelfth alpha version |
| `0.1.0-beta.1` | First beta version |
| `X.Y.Z`, `X.Y`, `X`, `latest` | Stable releases, starting at `1.0.0` |
| `stable` | Stable release explicitly promoted after a week |

Version tags omit the Git tag's `v` prefix. Debian app tags have a `-debian` suffix;
Zero tags have a `-zero` suffix. Nightly Zero tags are `nightly-zero` and
`nightly-zero-<sha>`. Prereleases never move `latest`, major/minor or `stable` tags.

For the beta Compose package, set `DITERO_IMAGE_TAG=0.1.0-beta.1` and follow the
[Compose setup](README.md#run-it-docker-compose). Extract the whole archive: bundled
PostgreSQL needs the adjacent initialization scripts. Helm instructions and required
Secret keys are in the [chart guide](deploy/helm/ditero/README.md).

## Release procedure

Review affected operator and client instructions using the
[documentation impact checks](docs/MAINTENANCE.md). Static checks do not establish
live upgrade, backup or restore qualification. Required CI and release preparation
also check cumulative documentation from the pinned alpha.10 review epoch through
the exact candidate. The fixed range retains earlier migration obligations when
later changes only alter queries. It is deliberately broader than the latest
release range; advancing the epoch requires an explicit reviewed policy migration.
Run `python3 -I scripts/docs-release.py` after committing the complete assessment.
Missing history, a changed epoch tag or unavailable tooling blocks publication.

1. Update `release.json` with the version and a strictly increasing Android version
   code. Align Helm chart metadata, Helm/Kustomize app/Zero image tags, and current
   version/image examples in both packaged deployment guides with that version
   before tagging. Release packaging checks reject mismatched guide examples.
   Native packaging applies the release version to Tauri and Android without
   rewriting generated files; Cargo's package version remains the base version.
2. Merge the release PR into `develop` for prereleases or `main` for stable releases.
   Wait for the latest CI, Security, Android, Desktop and Release packaging checks
   on that exact commit to pass. Failed or running checks block the release.
3. Create an annotated tag on the checked commit and push it separately:

   ```sh
   git tag -a v0.1.0-beta.1 <checked-commit> -m 'Ditero 0.1.0 beta 1'
   git push origin v0.1.0-beta.1
   ```

4. The Release workflow resolves the tag once, verifies branch ancestry and checks,
   and builds every artifact from that SHA. Container publication preserves image
   signing and scan gates. The GitHub release stays unpublished until all downloads
   are present and checked, then becomes a prerelease with `latest=false`.
5. Verify both registries' amd64/arm64 manifests and download checksums. Retain the
   Android signing identity securely so subsequent APKs upgrade existing installs.
6. After publication, update the current-release links in `README.md` and
   `docs/ROADMAP.md` and affected client guides through a
   documentation PR. Keep historical changelog entries and version-tag examples
   clearly distinguished from current installation guidance.

A failed workflow may be resumed using its existing tag through manual dispatch
at that tag ref, for example `gh workflow run release.yml --ref v0.1.0-beta.1
-f tag=v0.1.0-beta.1`. A dispatch from a different commit is rejected so build
provenance agrees with the released source.
An interrupted draft may be completed; published downloads are never replaced. If a
public release needs changes, increase the version and Android code and cut a new tag.
Container jobs can leave versioned images after another job fails; the GitHub release
is the complete artifact-set indicator.

## Signing configuration

Configure repository Actions secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` for
Docker Hub. GHCR uses the workflow token and container signing uses OIDC. An explicit
`DITERO_DOCKERHUB_ENABLED=false` repository variable permits a GHCR-only release; the
release notes disclose that omission.

Android release builds require these repository Actions secrets:

- `DITERO_ANDROID_KEYSTORE_BASE64`: base64-encoded retained private keystore.
- `DITERO_ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `DITERO_ANDROID_KEY_ALIAS`: signing alias.
- `DITERO_ANDROID_KEY_PASSWORD`: key password.

Secrets must never be committed or passed as command-line values. The workflow restores
the keystore into a private runner directory, verifies the APK signature and deletes
runner signing material after the build. It never invents a disposable update identity.
The APK certificate must match the public fingerprint recorded in `release.json`;
changing a secret cannot silently replace the Android update identity.
Manual certificate-backed desktop hooks remain available for future trusted Windows
signatures and macOS signing/notarization; see the native guides.

## Stable promotion

Starting at `v1.0.0`, run **Promote :stable** after a release has been live for at
least seven days without a follow-up patch. The workflow rejects prereleases and
moves `stable`, `stable-debian` and `stable-zero`. The age override does not permit
promoting an alpha or beta release.
