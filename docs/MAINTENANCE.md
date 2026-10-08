# Documentation impact

Changes to configuration, authentication, public APIs, terminal clients, native
contracts, public UI flows, deployment, release metadata or compatibility need
relevant guidance.
The narrow path map is in `scripts/docs-impact.py`. Internal and test-only changes
outside that map do not require documentation edits.

Run against fetched immutable commit IDs:

```sh
python3 -I scripts/docs-impact.py --base FULL_BASE_SHA --head FULL_HEAD_SHA --pr
python3 -I scripts/docs-impact.py --staged
python3 -I scripts/test-docs-impact.py
```

The PR comparison uses the merge base through the exact head, not the synthetic
checkout merge. Pushes compare the event's before/after commits. Missing objects,
invalid identities and an unavailable base policy fail; the tool does not guess a
baseline. The JSON result records checked commits, triggered groups and current
source digests. Range checks read committed Git blobs. The optional --staged mode
compares HEAD (or an explicit --base) with the index, including staged new files;
unstaged bytes are ignored. Unmerged entries, symlinks and submodules fail. Neither
mode executes application source. Public app/component/routes, maintained global
and theme styles, selected navigation/import/preferences hooks, native transport
and host contracts, and persisted offline-format boundaries are mapped. Test/spec
paths, declarations, images, vendored styles, component presentation CSS and
internal data hooks remain excluded; ordinary internal refactors need no guide edit.

Every triggered group needs a fresh source-bound assessment in
`.github/docs-impact.json`. Copy its current `sourceDigests` value from the report.
For a docs update, cite changed permitted guides and explain the update:

```json
{
  "version": 1,
  "groups": {
    "clients": {
      "sourceDigest": "REPLACE_WITH_REPORTED_64_CHARACTER_SHA256",
      "docs": ["docs/cli.md"],
      "note": "Document the changed command arguments and exit status for this source."
    }
  }
}
```

For behavior-preserving changes, the existing schema remains supported: replace
`docs` and `note` with a specific `noImpact` explanation of 30-2000 characters.
Both assessment forms must change in this range and match the current source.
Cited guides must actually change in this range and belong to the group. Later
source edits invalidate both forms, even when an earlier guide edit remains.
Do not reuse a stale explanation or add a generic acknowledgment. Unknown fields and duplicate
JSON keys fail. A reviewer must judge whether the rationale is true.

Compatibility guidance must discuss upgrade, backup, rollback and client versions.
Every compatibility assessment also requires specific `upgrade`, `backup`,
`rollback` and `clientVersions` explanations. SQL migrations and mapped
persisted-format/storage/patch boundaries require cited
recovery guides; they cannot use noImpact, even if a later commit only changes a
query. Other behavior-preserving compatibility refactors can use noImpact. Check
the whole release range: a narrower later comparison does not discharge earlier
obligations. Presence checks cannot prove compatibility. Actual database/schema,
attachment format or offline storage changes require accurate recovery instructions and appropriate tests.

Changed literal environment names in mapped configuration source must appear in
changed configuration guidance. The scan covers literal process/Bun environment
accesses and DITERO names; dynamically constructed names need manual review.
Changed Markdown links are checked against tracked Git paths; deleting Markdown
also checks inbound links. External URLs are never fetched. Common inline and
reference destinations are supported, including percent-encoded spaces. Anchors,
complex CommonMark syntax and code examples are outside this bounded check.

CI uses the base commit's standalone policy before dependency installation, with
read-only permissions and no credentials retained by checkout. It never imports
head application code. Ordinary product tests still execute the proposed code in
the existing hosted CI jobs. Policy/workflow edits require source review.
The one-time assessment-schema
migration is restricted to the reviewed base 9854e1d8fc513f2972eab175f2837969b9a636cf
and checker SHA-256 b408a044c9bbaec1f26e9f67c713a5f57501ca05cfc57913933dd9ca0ba247c9.
That exceptional run executes the reviewed proposed policy and reports a migration
warning; it is not base-owned policy proof. Later checks remain base-owned and
fail closed. This does not alter the separate initial bootstrap pin.

The first guard PR needs a single explicit CI bootstrap base pin, set to the
reviewed immutable base commit. That exceptional run executes the proposed policy
and prints a bootstrap warning; it is not base-owned policy proof. All subsequent
missing-policy cases fail. Do not change the pin to bypass a later failure.

Release packaging checks local links across tracked canonical guides: README,
RELEASING, CONTRIBUTING, SECURITY, public docs Markdown and apps/deployment READMEs.
Historical changelogs, test/site/asset guides, vendored notices and generated or
package documentation are excluded. It also inventories literal public settings
in production src/config, deployment files and mapped native configuration,
including the DITERO_E2E_ENABLED encryption switch. Only the test-crash module, NODE_ENV and explicit DITERO_TEST_/E2E_ test
prefixes are excluded. Names must appear in those guides or .env.example.
This does not discover dynamically constructed names or arbitrary unmapped
configuration surfaces. Literal process/Bun accesses and DITERO names are scanned;
rendered configuration and generated contracts keep their separate checks.
The result lists exact checked guides, source files and configuration names.
Existing release validation runs separately. Version/tag/source, generated API
contracts, catalogs and deployment rendering retain their existing gates. Prepared develop metadata may
differ from the latest published alpha; current download links must describe the
published release. A green static guard does not qualify deployment, restore,
native runtime support or binary redistribution.
