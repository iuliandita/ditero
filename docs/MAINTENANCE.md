# Documentation impact

Changes to configuration, authentication, public APIs, terminal clients, native
contracts, deployment, release metadata or compatibility need relevant guidance.
The narrow path map is in `scripts/docs-impact.py`. Internal and test-only changes
outside that map do not require documentation edits.

Run against fetched immutable commit IDs:

```sh
python3 -I scripts/docs-impact.py --base FULL_BASE_SHA --head FULL_HEAD_SHA --pr
python3 -I scripts/test-docs-impact.py
```

The PR comparison uses the merge base through the exact head, not the synthetic
checkout merge. Pushes compare the event's before/after commits. Missing objects,
invalid identities and an unavailable base policy fail; the tool does not guess a
baseline. The JSON result records checked commits, triggered groups and current
source digests. It reads committed Git blobs, so commit local changes first.

Changed relevant guides qualify directly. If a mapped source change preserves
documented behavior, copy that group's `sourceDigests` value from the report into
`.github/docs-impact.json` with a specific explanation:

```json
{
  "version": 1,
  "groups": {
    "clients": {
      "sourceDigest": "REPLACE_WITH_REPORTED_64_CHARACTER_SHA256",
      "noImpact": "Move command parsing helpers without changing arguments, output or exit codes."
    }
  }
}
```

The entry must change in this range and match the current source. Do not reuse a
stale explanation or add a generic acknowledgment. Unknown fields and duplicate
JSON keys fail. A reviewer must judge whether the rationale is true.

Compatibility guidance must discuss upgrade, backup, rollback and client versions.
For a no-impact compatibility refactor, the declaration also requires specific
`upgrade`, `backup`, `rollback` and `clientVersions` explanations. Presence checks
cannot prove compatibility. Actual database/schema, attachment format or offline
storage changes require accurate recovery instructions and appropriate tests.

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

The first guard PR needs a single explicit CI bootstrap base pin, set to the
reviewed immutable base commit. That exceptional run executes the proposed policy
and prints a bootstrap warning; it is not base-owned policy proof. All subsequent
missing-policy cases fail. Do not change the pin to bypass a later failure.

Release packaging checks local links across tracked canonical guides: README,
RELEASING, CONTRIBUTING, SECURITY, public docs Markdown and apps/deployment READMEs.
Historical changelogs, test/site/asset guides, vendored notices and generated or
package documentation are excluded. It also inventories literal public settings
in production src/config TypeScript, including the DITERO_E2E_ENABLED encryption
switch. Only the test-crash module, NODE_ENV and explicit DITERO_TEST_/E2E_ test
prefixes are excluded. Names must appear in those guides or .env.example.
This does not discover configuration outside src/config or dynamically built names.
The result lists exact checked guides, source files and configuration names.
Existing release validation runs separately. Version/tag/source, generated API contracts, catalogs and
deployment rendering retain their existing gates. Prepared develop metadata may
differ from the latest published alpha; current download links must describe the
published release. A green static guard does not qualify deployment, restore,
native runtime support or binary redistribution.
