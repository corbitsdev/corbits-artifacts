# Changelog

All notable changes to `@corbits/artifacts` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are
always called out under their own heading.

## [0.2.0] — 2026-09-25

### Added

- `POST /api/artifacts/:id/versions` revises an uploaded file with new bytes
  when sent as `multipart/form-data` with one `file` field and an optional
  `expectedVersion`. The bytes go through the configured `ContentStore` and
  upload policy (`415` for a refused type, `413` over `MAX_UPLOAD_BYTES`),
  and are stored only after the version check passes. The title carries
  forward; the version downloads under the new file's name.
  `reviseFileArtifact` is the underlying function.
- Upload bytes are versioned. Each version records its own content
  reference in `artifact_version.source` (added by `0004_version_source`,
  which backfills existing versions), so `GET .../download?version=N` and
  `GET .../versions/:version` return that version's file after a revision.

### Changed

- `@intx/agent` is an optional peer. Only `@corbits/artifacts/sidecar-bundle`
  imports it.
- `arktype` is a regular dependency instead of a peer.
- `@intx/db` is a new peer. The minimum `@intx/*` is **0.4.0**.

### Breaking

- `mountArtifacts(app, opts)` is replaced by `createArtifactRoutes(deps)`,
  which returns a `Hono<TenantEnv>` sub-app the host mounts with
  `app.route(...)`. `MountArtifactsOpts` is renamed `CreateArtifactRoutesDeps`.
- `mountWorkflowArtifacts(app, opts)` is replaced by
  `createWorkflowArtifactRoutes(deps)`, a sub-app the host mounts at
  `/api/workflow-artifacts`. `MountWorkflowArtifactsOpts` is renamed
  `CreateWorkflowArtifactRoutesDeps`.
- `POST /artifacts` and `POST /artifacts/upload` require
  `requireGrant("artifact:*", "create")`. On upgrade from 0.1.0, the
  migrations grant `create` on `artifact:*` to every principal that has
  already created an artifact in its tenant, in the host's `grant` table.
  New principals need the grant from the host. An unauthenticated caller now gets
  `{ "error": "Forbidden" }` instead of `{ "error": "Tenant not accessible" }`.
- `runArtifactMigrations(config, { schema })` takes the same arguments as
  Interchange's `runMigrations`: a `DBConfig` and the host schema holding
  `tenant` and `principal`. It applies the idempotent SQL files shipped under
  `migrations/` with no ledger. The `adopt` option,
  `RunArtifactMigrationsOptions`, `MigrationChecksumError` and
  `MigrationAdoptError` are removed.
- The first 0.2.0 boot drops the `artifacts.migrations` ledger, so a
  database cannot go back to 0.1.0. Do not run 0.1.0 and 0.2.0 replicas
  against the same database.
- The drizzle tables (`artifact`, `artifactVersion`, `upload`,
  `mailAttachmentRef`) are no longer exported. `ARTIFACTS_SCHEMA` and the
  `*Row` types stay public.
- `SKILL_DRAFT_KIND` is removed. `skill-draft` is an ordinary `kind`.
- `web_site` handling is removed: content is stored as given, `readArtifact`
  no longer takes `path`, and every `WEB_SITE_*` constant and web-site
  helper and type is no longer exported.
- Mail attachment references are removed: the
  `/instances/:instanceId/mail-attachments` routes, `saveMailAttachmentRefs`,
  `listMailAttachmentRefs`, `MAIL_ATTACHABLE_KINDS`,
  `MailAttachmentKindError`, `MAX_MAIL_ATTACHMENT_BYTES`,
  `MAX_MAIL_ATTACHMENTS_PER_MAIL` and `MailAttachmentRefRow`.
  `0003_drop_mail_attachment_ref` drops the table and its rows.
- `windowContent` is no longer exported.
- Node 24 or newer is required (0.1.0 accepted Node 22).

## [0.1.0] — first release

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

[0.2.0]: https://github.com/corbitsdev/corbits-artifacts
[0.1.0]: https://github.com/corbitsdev/corbits-artifacts
