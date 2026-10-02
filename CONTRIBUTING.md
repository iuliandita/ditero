# Contributing to Ditero

Ditero is pre-alpha. Development targets `develop`; breaking changes are expected.
Use [Docker Compose](README.md#run-it-docker-compose) to run the application, and
the [Android](apps/android/README.md) or [desktop](apps/desktop/README.md) guides
for native builds.

## Workflow

- Branch off `develop`. All work merges back into `develop` via pull request.
- `main` only receives release merges. Do not open PRs against `main`.
- Keep commits focused. Rebase your branch on `develop` before opening the PR.

```sh
git checkout develop && git pull
git checkout -b feat/my-thing
# ... work ...
git push -u origin feat/my-thing
```

Open a PR against `develop` and fill in the template.

## Commit style

Conventional commits: `type(scope): description`.

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`, `test`.

Examples:

- `feat(lists): add fractional-index reordering`
- `fix(zero): deny sync for non-members`
- `docs: document the release flow`

Keep subjects plain ASCII and at most 72 characters. Put detail in the body.

## Code style

- TypeScript strict mode. No `any` — use `unknown`, generics, or proper types.
- **Minimal comments.** Comment only what the code cannot say for itself (a non-obvious
  invariant, a workaround, a "why"). No narration of what the next line does.
- Remove dead code, obsolete files, and unneeded temp/cache artifacts as part of your change.
- Match the surrounding style.

## Sync dependency patch

Zero is pinned to 1.9.0 with a Bun package patch under `patches/`. The patch makes
`Zero.close()` persist accepted local edits before releasing the client, so sign-in
and language reloads preserve queued changes. Frozen installs apply it in both
application Docker stages. Prepare changes with `bun patch` before editing installed
runtime files, which may share hardlinks with the install cache. When upgrading
Zero, keep the close/reopen and storage failure regression checks passing before
removing or replacing the patch.

## Before opening a PR

Install dependencies with `bun install --frozen-lockfile`, then run:

```sh
bun run lint
bun run i18n:compile
bun run i18n:validate
bun run typecheck
bun run test
```

Run `bun run test:integration` and `bun run test:e2e` for changes affecting server,
sync, or user workflows. These checks start isolated Docker fixtures. CI also runs
container smoke checks and requires every job through its aggregate verification gate.
See the [browser test guide](tests/e2e/README.md) for projects, shards, and artifacts.

Run host Chromium E2E tests separately from container lifecycle checks. Starting or stopping
unrelated containers can change host network interfaces and interrupt browser requests with
`net::ERR_NETWORK_CHANGED`. Use an idle Docker host or a dedicated CI runner. Failed browser
tests retain screenshots and traces under `test-results/`; inspect these before retrying.
