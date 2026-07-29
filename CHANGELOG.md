# Changelog

All notable changes to `@corbits/artifacts` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are
always called out under their own heading.

## [Unreleased]

### Changed

- The repository root **is** the `@corbits/artifacts` package. The previous
  `packages/artifacts` workspace nesting is gone so
  `bun add github:corbitsdev/corbits-artifacts` installs cleanly. Bun consumers
  resolve TypeScript sources via the `bun` export condition; Node consumers
  continue to use the built `dist/` from `npm pack` / a published release.

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
  with its own ledger table (`artifacts.migrations`) and silent re-runs. Safe to
  call on every boot of every replica. All tables live in the package-owned
  `artifacts` Postgres schema; nothing resolves through `search_path`.
- Four tables — `artifact`, `artifact_version`, `upload`, `mail_attachment_ref`
  — with hard foreign keys into Interchange's `public.tenant` /
  `public.principal` and append-only version history.
- `ContentStore` port with two shipped implementations, `InlineContentStore`
  (bytea side-table) and `DataUrlContentStore` (inline `data:` URL), both
  passing the same suite.
- Host options: `resolvePrincipal`, plus `isAdmin`, `identity` and
  `decorate`, each with a fail-closed default.
- Agent-facing tool definitions with windowed artifact reads, and the `web_site`
  artifact kind.
- Requires `@intx/*` 0.2.2 or newer, Node 22+ or Bun 1.1+, and Postgres 13+.
  (`@intx/*` 0.1.2 does not install — its deps pin the unpublished
  `@intx/*@0.0.0` — and ships raw TypeScript.)
- No publish workflow yet: consume from a git checkout or an `npm pack` tarball.

[Unreleased]: https://github.com/corbitsdev/corbits-artifacts
