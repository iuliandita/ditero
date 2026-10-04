# Project website

Static HTML at https://iuliandita.github.io/ditero/. This is the configured target;
it is not a claim that deployment has completed.

Run `bun install --frozen-lockfile`, then `bun run scripts/build-site.ts`.
The generated `site/dist/` contains English at the root, five translated pages,
CSS and copied public brand assets. No JavaScript, remote fonts or trackers are used.

Run `bunx vitest run scripts/build-site.test.ts --exclude 'docs/local/**'` to check
strict locale completeness, escaping, generated paths and RTL output. Text belongs
in the six `site/locales/` dictionaries; markup belongs in the shared template.
The builder rejects missing or extra dictionary keys. All locale values are escaped
as text, including attribute values. Relative paths support the `/ditero/` Pages base.

Content describes published `v0.0.1-alpha.2`. A prepared release or a merged develop
feature does not change that claim. Update all six dictionaries and pinned guide links
only after checking the next published release and its client limitations.

The workflow builds pull requests with read-only repository permissions. Only develop
pushes and manual runs on develop deploy, through the `github-pages` environment.
Configure Pages to use GitHub Actions and preserve environment protection rules;
restrict the deployment branch to develop. Repository configuration is separate from
this workflow. No custom domain, DNS change or credential provisioning is included.

Before publication, inspect all six pages in light/dark themes, Arabic RTL, keyboard
navigation and a narrow viewport. Build tests alone do not prove rendered usability.
