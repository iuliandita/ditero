# Contributing to Ditero

Ditero is pre-alpha. The application spine is still being built, so the dev setup below is a
work in progress and will firm up as milestones land.

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

## Before opening a PR

Once the toolchain lands, PRs are expected to pass lint, typecheck, and tests. The PR
template lists the checks. CI runs them too.
