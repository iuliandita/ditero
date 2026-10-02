# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Ditero, please report it privately. **Do not open a public issue.**

### Preferred: GitHub Private Vulnerability Reporting

Use GitHub's built-in [private vulnerability reporting](https://github.com/iuliandita/ditero/security/advisories/new) to submit a report. This keeps the details confidential until a fix is available.

### Alternative: Direct Contact

Reach out to [@iuliandita](https://github.com/iuliandita) via GitHub.

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

There is no tagged release yet. Security fixes land on `develop` and its nightly
images; development artifacts have no stable support window. Once releases exist,
only the latest release will receive security fixes.
