# Releasing

Ditero uses a channel-based release flow. Development happens on `develop` with `0.x.y`
versions; stable `1.x.y` releases are cut from `main`.

## Branches

- **`develop`** — integration branch and default branch. All work merges here via PR.
- **`main`** — release branch. Only receives release merges from `develop`.

Every change lands on a branch, goes through a PR, and merges into `develop`. Never commit
directly to `develop` or `main`.

## Channels and image tags

Images publish to `ghcr.io/iuliandita/ditero` and `docker.io/iuliandita/ditero`.

| Tag | Meaning | Produced by |
| --- | --- | --- |
| `:nightly`, `:nightly-<sha>` | Bleeding edge, every merge to `develop` | `nightly.yml` |
| `:vX.Y.Z`, `:X.Y`, `:X` | A specific release | `release.yml` |
| `:latest` | The newest release | `release.yml` |
| `:stable` | A release that soaked without a follow-up patch | `promote-stable.yml` |

Each app tag has a `-debian` counterpart (e.g. `:latest-debian`) and each channel has a
`-zero` counterpart for the zero-cache service. Unsuffixed app images are Alpine.

## Flow

1. **Develop.** Merge PRs into `develop`. Each merge builds and pushes `:nightly` — a
   throwaway channel, not gated on full CI.
2. **Soak.** Let `develop` run on `:nightly` for a few days.
3. **Release.** Merge `develop` into `main`, then push a tag `vX.Y.Z`. `release.yml` runs the
   quality gate, builds the Alpine (default) and `-debian` images multi-arch, signs them with
   cosign, generates SBOMs, publishes the zero-cache image, creates a GitHub release, and moves
   `:latest` and `:latest-zero`.
4. **Promote to stable.** One week after a `:latest` release with no follow-up patch, run the
   **Promote :stable** workflow (manual dispatch) with the tag. It retags that release as
   `:stable`, `:stable-debian`, and `:stable-zero`. The workflow soft-checks the 7-day age;
   younger releases need an explicit override.

## Versioning

- Pre-`1.0.0`: `0.x.y` from `develop`. Breaking changes are expected.
- `1.0.0` onward: semver from `main`. Patch releases are `vX.Y.Z`; a patch resets the
  one-week soak clock before the next `:stable` promotion.
