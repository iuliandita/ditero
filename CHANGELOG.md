# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Notification delivery engine: leader-elected scheduler, an outbox worker on every replica
  with `FOR UPDATE SKIP LOCKED` claims, lease reclaim and fenced completion writes, a retry
  ladder bounded at 15 attempts, quiet hours, escalation to a fallback member, and per-user
  queue caps. Validated by a rig that kills real replicas mid-send.
- ntfy delivery channel, with encrypted-at-rest credentials, a masked settings form, and a
  rate-limited test send. Telegram, Discord, Slack, and email are not implemented.
- Acknowledgement: an in-app control and a single-use capability link in the notification
  itself, expiring after 24 hours, which terminates every sibling reminder on the occurrence.
- Assignment, `@`-mention, and overdue event notifications.
- `DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS` to allow notification egress to named private ranges,
  with never-allowable ranges enforced regardless.
- Notification documentation, including the at-least-once, drop-path, and non-medical-grade
  disclaimers: [docs/notifications.md](docs/notifications.md).
- Repository foundation: license, contributor docs, issue/PR templates, and the
  CI/nightly/release/promote-stable workflows that implement the channel-based release flow.
