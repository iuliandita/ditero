# Releasing

Ditero builds server containers and native clients from one release commit. Development
happens on `develop`; `0.x.y` releases are prereleases. Stable `1.x.y` releases come
from `main`. Every change lands through a PR.

## Build artifacts

Every push and PR builds Android development APKs and unsigned or ad-hoc desktop
installers. These test artifacts expire after seven days. Release packaging checks
also retain Helm, Kustomize and Compose packages for 30 days. Linux x64 standalone
CLI, MCP and TUI candidates are built and exercised internally without Bun.
Their embedded runtime notices remain incomplete in [#575](https://github.com/iuliandita/ditero/issues/575);
compiled clients are excluded from release assets and public Actions uploads.

Tagged releases include:

- Alpine and Debian app containers and the Zero container, for amd64 and arm64,
  at `ghcr.io/iuliandita/ditero` and `docker.io/iuliandita/ditero`.
- Container signatures, provenance and SPDX SBOMs, plus immutable image digest files.
- Helm and Kustomize packages for app and Zero with external PostgreSQL, and a
  Compose archive containing the bundled PostgreSQL initialization scripts.
- Linux x86_64 DEB and AppImage, unsigned Windows x86_64 installer, and an ad-hoc
  signed macOS Apple Silicon DMG.
- A signed independent Android universal APK and AAB. This flavor uses UnifiedPush;
  Google delivery requires separate private configuration and is not packaged here.
- `SHA256SUMS.txt` covering every download.

Windows installers have no trusted publisher signature. macOS downloads have ad-hoc
signatures and are not notarized. Native device/platform qualification, general deep
links and automatic updates remain incomplete; an alpha package does not establish
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
| `X.Y.Z`, `X.Y`, `X`, `latest` | Stable releases, starting at `1.0.0` |
| `stable` | Stable release explicitly promoted after a week |

Version tags omit the Git tag's `v` prefix. Debian app tags have a `-debian` suffix;
Zero tags have a `-zero` suffix. Nightly Zero tags are `nightly-zero` and
`nightly-zero-<sha>`. Prereleases never move `latest`, major/minor or `stable` tags.

For the alpha Compose package, set `DITERO_IMAGE_TAG=0.0.1-alpha.5` and follow the
[Compose setup](README.md#run-it-docker-compose). Extract the whole archive: bundled
PostgreSQL needs the adjacent initialization scripts. Helm instructions and required
Secret keys are in the [chart guide](deploy/helm/ditero/README.md).

## Release procedure

1. Update `release.json` with the version and a strictly increasing Android version
   code. Align Helm chart metadata and Helm/Kustomize app/Zero image tags with that version.
   Native packaging applies the release version to Tauri and Android without
   rewriting generated files; Cargo's package version remains the base version.
2. Merge the release PR into `develop` for prereleases or `main` for stable releases.
   Wait for the latest CI, Security, Android, Desktop and Release packaging checks
   on that exact commit to pass. Failed or running checks block the release.
3. Create an annotated tag on the checked commit and push it separately:

   ```sh
   git tag -a v0.0.1-alpha.5 <checked-commit> -m 'Ditero 0.0.1 alpha 5'
   git push origin v0.0.1-alpha.5
   ```

4. The Release workflow resolves the tag once, verifies branch ancestry and checks,
   and builds every artifact from that SHA. Container publication preserves image
   signing and scan gates. The GitHub release stays unpublished until all downloads
   are present and checked, then becomes a prerelease with `latest=false`.
5. Verify both registries' amd64/arm64 manifests and download checksums. Retain the
   Android signing identity securely so subsequent APKs upgrade existing installs.

A failed workflow may be resumed using its existing tag through manual dispatch
at that tag ref, for example `gh workflow run release.yml --ref v0.0.1-alpha.5
-f tag=v0.0.1-alpha.5`. A dispatch from a different commit is rejected so build
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
