# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Ditero, please report it privately. **Do not open a public issue.**

### Preferred: GitHub Private Vulnerability Reporting

Use GitHub's built-in [private vulnerability reporting](https://github.com/iuliandita/ditero/security/advisories/new) to submit a report. This keeps the details confidential until a fix is available.

### Alternative: Direct Contact

Use private vulnerability reporting above; a GitHub profile is not a private
contact channel. Include the affected alpha or nightly tag, source commit, impact
and a minimal reproduction. Remove unrelated secrets and personal data.

## What to Expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix and disclosure coordinated with you before any public announcement

## Scope

This policy covers the Ditero web, Android, and desktop application code, container
images, deployment files, and optional push relay in this repository. It does not
cover third-party services Ditero integrates with (identity providers, notification
channels, or a user-supplied PostgreSQL instance).

## Supported Versions

Security fixes target the latest published alpha prerelease (currently
[`v0.0.1-alpha.12`](https://github.com/iuliandita/ditero/releases/tag/v0.0.1-alpha.12))
and `develop`/nightly builds. Older alphas receive no backported fixes. There is
no stable release or stable support window yet; native qualification remains
in progress as described in the [README](README.md).
