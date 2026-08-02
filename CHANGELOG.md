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
- `mountArtifacts` takes an optional `onArtifactCreated(tx, row, scope)` hook,
  run inside the same transaction as artifact creation (once per row, so once
  on `POST /artifacts` and once per file on `POST /artifacts/upload`). This is
  the seam a host uses to provision grants for the row it just made — for
  example, a `creator`-origin grant on `artifact:<id>` for `write` and
  `archive`. Defaults to a no-op, so existing hosts are unaffected.
  `examples/reference-host` now wires a real one (`grantOwnership`) against
  Interchange's own `grant` table, and its default `requireGrant` is the
  platform's real `createRequireGrant` over that table rather than a
  default-allow stub — see ARCHITECTURE.md's "Grant provisioning" section.

### Breaking

- `mountArtifacts` takes `Hono<TenantEnv>`, reads the host-provided tenant and
  principal context natively, and requires the host's Interchange `RequireGrant`
  middleware. The `resolvePrincipal`, `isAdmin`, and `identity` options and the
  `Identity` / `anonymousIdentity` exports are not part of the package surface.
- Serialized artifact rows expose `ownerPrincipalId` without an `ownerName`.
  Artifact lists no longer accept `creatorKind`.
- **Cross-tenant tool reads are removed, intentionally, not just undocumented.**
  `readArtifact` / `readArtifactChunk` no longer take a `tenantId` override;
  tool reads are always confined to `scope.tenantId`. The prior override read
  through `Identity.ownerIsMemberOfTenant`, a membership policy this package
  invented and owned — exactly what this PR removes. It is not replaced by a
  grant check because there is no platform primitive to replace it with:
  Interchange's `GrantStore` resolves a principal's grants within one tenant
  (a principal is itself a row scoped to one tenant), so "grant readable
  across tenants" does not exist to check. Reintroducing cross-tenant reads
  here would mean this package inventing a second, bespoke cross-tenant
  authorization concept on top of the platform's — the failure mode this PR
  exists to remove. If a real need for it surfaces, it belongs in
  Interchange's grant model, not a per-package workaround.

### 0.1.0 — first release

Initial public release. Nothing has been published before this, so everything is
new; the list below is what the surface consists of rather than what changed.

- `mountArtifacts(app, opts)` — mounts artifacts, versions and uploads on a
  host's existing Hono app: tenant-scoped list with keyset paging and
  query/kind/owner/date filters, human import of a link or pasted text,
  multipart upload, deep-link detail, version history and revision, idempotent
  soft archive and unarchive, a single download path, and artifact↔message
  attachment refs. Every route carries OpenAPI metadata.
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
- Host options: required `db`, `contentStore`, and `requireGrant`, plus optional
  display-only `decorate` and `uploadPolicy` behavior.
- Agent-facing tool definitions with tenant-confined windowed artifact reads,
  and the `web_site` artifact kind.
- Requires `@intx/*` 0.2.2 or newer, Node 22+ or Bun 1.1+, and Postgres 13+.
  (`@intx/*` 0.1.2 does not install — its deps pin the unpublished
  `@intx/*@0.0.0` — and ships raw TypeScript.)
- No publish workflow yet: consume from a git checkout or an `npm pack` tarball.

[Unreleased]: https://github.com/corbitsdev/corbits-artifacts
