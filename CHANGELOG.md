# Changelog

All notable changes to `@corbits/artifact-core` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are
always called out under their own heading.

## [Unreleased]

### 0.1.0 — first release

Initial public release. Nothing has been published before this, so everything is
new; the list below is what the surface consists of rather than what changed.

- `mountArtifacts(app, opts)` — mounts artifacts, versions and uploads on a
  host's existing Hono app: tenant-scoped list with keyset paging and
  query/kind/owner/creator-kind/date filters, human import of a link or pasted
  text, multipart upload, deep-link detail, version history and revision,
  idempotent soft archive and unarchive, a single download path, and
  artifact↔message attachment refs. Every route carries OpenAPI metadata.
- `runArtifactMigrations(db)` — idempotent, advisory-locked, checksum-guarded,
  with its own ledger table and silent re-runs. Safe to call on every boot of
  every replica, and mountable under a host's own Postgres schema via
  `search_path`.
- Four tables — `artifact`, `artifact_version`, `upload`, `mail_attachment_ref`
  — with zero control-plane foreign keys and append-only version history.
- `ContentStore` port with two shipped implementations, `InlineContentStore`
  (bytea side-table) and `DataUrlContentStore` (inline `data:` URL), both
  passing the same suite.
- Host seams: `resolvePrincipal`, plus `adminAuthz`, `identity` and
  `provenance`, each with a fail-closed default.
- Agent-facing tool definitions with windowed artifact reads, and the `web_site`
  artifact kind.
- Requires `@intx/*` 0.2.2 or newer, Node 22+ or Bun 1.1+, and Postgres 13+.

[Unreleased]: https://github.com/corbitsdev/corbits-artifacts
