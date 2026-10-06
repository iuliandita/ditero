# Website forwarding pages

The canonical Ditero website is https://ditero.app/, maintained in the separate
[website repository](https://github.com/iuliandita/ditero-web).

GitHub Pages at https://iuliandita.github.io/ditero/ forwards existing links to
that website. English forwards to its root; de, es, fr, ro and ar forward to the
matching locale paths. Each HTML page has a canonical URL, an immediate refresh
and a visible localized fallback link. No JavaScript, images, fonts or trackers
are needed. These pages make no release or product-feature claims.

Run `bun install --frozen-lockfile`, then `bun run scripts/build-site.ts`.
The generated `site/dist/` contains six forwarding pages and `.nojekyll`.
Run `bunx vitest run scripts/build-site.test.ts --exclude 'docs/local/**'` to check
locale targets, canonical URLs, fallback links, escaping, output paths and RTL.
Forwarding text belongs in `scripts/build-site.ts`; markup belongs in the template.
The old locale dictionaries and source assets are retained but are not published
by this builder.

The existing Pages workflow still builds pull requests with read-only repository
permissions. Only develop pushes and manual runs on develop deploy through the
`github-pages` environment. Preserve its environment protection and deployment
branch rules. Website hosting and deployment remain in the website repository.
