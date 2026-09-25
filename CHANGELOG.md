# Changelog

All notable changes to `@corbits/artifacts` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until 1.0, a minor bump may contain a breaking change; breaking changes are
always called out under their own heading.

## [Unreleased]

### Added

- Run-scoped `POST /artifacts`, `POST /artifacts/binary`, and
  `PATCH /artifacts/:id` (`mountWorkflowArtifacts`) accept an optional
  `metadata` field, matching the tenant routes' semantics exactly: omitted on
  a revise carries the prior version's metadata forward, an explicit `null`
  clears it, and any other value must be a JSON object or the request is
  `400`. `artifact_create` and `artifact_write` in `ARTIFACT_TOOL_DEFINITIONS`
  gain a matching optional `metadata` object parameter, and the sidecar
  bundle forwards it to the route unchanged. `source` (`{ origin: "workflow",
  runId }`) and `generatedBy` stay server-stamped from the resolved run
  scope — never read from `metadata` or any other body field.
- `artifact_version.content_sha256` (text, nullable), added by the new
  `0005_version_content_digest` migration and mirrored onto
  `artifact.content_sha256` the same way `metadata` already mirrors. Computed
  at write time — sha256 (hex) over the UTF-8 bytes of `content` for text and
  URL artifacts, or over the uploaded bytes for a blob-backed file artifact's
  version 1, since its `content` column is a store-specific pointer, not the
  bytes. A metadata/title-only revise (content omitted, so it carries
  forward) carries the digest forward unchanged. Returned as `contentSha256`
  on `GET /api/artifacts/:id`, `GET /api/artifacts/:id/versions/:version`,
  `GET /api/artifacts/:id/versions`, and the `POST /api/artifacts/:id/versions`
  response. Existing rows serialize `contentSha256: null` — written before
  digests existed, and never backfilled.
- `expectedVersion` (positive integer, optional) on
  `POST /api/artifacts/:id/versions`. Checked under the same `SELECT ... FOR
  UPDATE` that guards the version bump: a mismatch answers `409
  {"error":"Version conflict","currentVersion":N}` and writes nothing.
  Omitting it is today's unconditional-write behavior. Lets a caller bind a
  revise to the exact version it last read — for example, a human approval on
  specific content — instead of silently overwriting a change it never saw.
- `ARTIFACT_UPLOAD_POLICY` accepts packaged archives — `application/gzip` /
  `application/x-gzip` (`.tar.gz`, `.tgz`, `.gz`) and `application/x-tar`
  (`.tar`) — so consumers storing packaged builds are no longer refused with
  415. An archive mints kind `file`, is never inline-previewable (the
  download path's inline allow-list is `application/pdf` only), and is still
  subject to the existing `MAX_UPLOAD_BYTES` per-file ceiling.
- `GET /api/artifacts/:id/versions/:version` — one version including its
  content, reusing `getArtifactVersion`, the same read authorization as
  `GET /api/artifacts/:id`, and the same response shape. A malformed or
  sub-1 version is `400`; an unknown version collapses into the same `404
  Artifact not found` every other single-artifact failure mode does.
- `GET /api/artifacts/:id/download?version=N` — pins the download to that
  version's content for the data-URL and downloadable-text conventions,
  where content really is per-version; omitting `version` is unchanged. Same
  `400`/`404` rules as the new versions route, plus one more: a blob-backed
  upload's `ContentStore` reference lives on the artifact row's own
  `source`, never per-version, so `?version=N` for one is `400 "Uploaded
  file content is not versioned"` unless `N` names the current version —
  rather than silently answering with today's blob under an older version's
  name.
- `artifact_version.metadata` (jsonb, nullable) and
  `artifact_version.parent_version_ids` (text[], nullable), added by the new
  `0004_version_metadata` migration. `metadata` is opaque to the package —
  stored and returned as-is on every version read — and `artifact.metadata`
  mirrors the current version's value the same way `title`/`content`/
  `version` already do. `parentVersionIds` is explicit lineage set by the
  writer and is never inferred from version order or carried forward between
  versions. `createArtifact`, `writeArtifactVersion`, and
  `findOrVersionArtifact` all accept optional `metadata` and
  `parentVersionIds`; `getArtifactVersion` and `listArtifactVersions` return
  both fields alongside each version.
- `findOrVersionArtifact(db, args)` — the atomic primitive behind "find an
  artifact by title, create it if absent, add a version if present." The
  schema's only uniqueness is `(artifactId, version)`; nothing constrains
  `(tenantId, title, kind)`, so that common pattern raced between the read
  and the write when hand-rolled outside the package. This closes the race
  with a transaction-scoped advisory lock keyed on `(tenantId, kind, title)`:
  concurrent callers for the same triple always converge on one artifact —
  the first to acquire the lock creates it, every other caller revises the
  row the first one just committed. A uniqueness constraint on
  `(tenant_id, title, kind)` was considered instead but rejected:
  `createArtifact` is a public, unconditional insert used directly by the
  import route, uploads, and `artifact_link_file`, and a shared title across
  independent creates on those paths is normal, not a bug a schema
  constraint should forbid. See the find-or-version notes in
  CONTRIBUTING.md.

### Changed

- `@intx/agent` is an optional peer. Only `@corbits/artifacts/sidecar-bundle`
  imports it, so a host that mounts the routes alone need not install it.
- `arktype` is a regular dependency (`^2.2.3`) instead of a peer, so hosts no
  longer install it themselves. The exported query schemas are still arktype
  types; a host on another arktype version gets its own copy alongside.
- Minimum `@intx/*` is now **0.3.0**. (`@intx/*` lines before 0.3.0 do not
  install — older lines pin the unpublished `@intx/*@0.0.0` or ship raw
  TypeScript.)
- The repository root **is** the `@corbits/artifacts` package. The previous
  `packages/artifacts` workspace nesting is gone so
  `bun add github:corbitsdev/corbits-artifacts` installs cleanly. Bun consumers
  resolve TypeScript sources via the `bun` export condition; Node consumers
  continue to use the built `dist/` from `npm pack` / a published release.
- `createArtifactRoutes` takes an optional
  `onArtifactCreated(tx, row, scope)` hook, run inside the same transaction
  as artifact creation (once per row, so once on `POST /artifacts` and once
  per file on `POST /artifacts/upload`). This is
  the seam a host uses to provision grants for the row it just made — for
  example, a `creator`-origin grant on `artifact:<id>` for `write` and
  `archive`. Defaults to a no-op, so existing hosts are unaffected.
  `examples/reference-host` now wires a real one (`grantOwnership`) against
  Interchange's own `grant` table, and its default `requireGrant` is the
  platform's real `createRequireGrant` over that table rather than a
  default-allow stub — see CONTRIBUTING.md's "Grant provisioning" section.
- Single-artifact write routes (`POST .../versions`, `POST .../archive`,
  `POST .../unarchive`) now resolve existence/tenant/skill-draft (the same
  check `loadScoped` does) BEFORE running `requireGrant`, not after. A real,
  resource-specific grant evaluator has no existence check of its own — it
  denies a ghost id or another tenant's artifact with the same `403` it would
  give for a real row the caller lacks permission on, which a default-allow
  stub can never surface. This restores the documented "a caller who cannot
  see the artifact gets 404" guarantee for write routes running a real grant
  check, matching what already held for reads.

### Breaking

- `mountArtifacts(app, opts)` is replaced by `createArtifactRoutes(deps)`,
  which returns a `Hono<TenantEnv>` sub-app the host mounts with
  `app.route(...)` instead of mutating the host app. `MountArtifactsOpts` is
  renamed `CreateArtifactRoutesDeps`; the options are unchanged.
- `POST /artifacts` and `POST /artifacts/upload` now require
  `requireGrant("artifact:*", "create")`, as hub-api's `createGrantRoutes`
  requires `create` on `grant:*`. A host must grant its principals `create`
  on `artifact:*` for them to keep creating artifacts. An unauthenticated
  caller of these two routes now gets `{ "error": "Forbidden" }` instead of
  `{ "error": "Tenant not accessible" }`.
- `runArtifactMigrations(config, { schema })` takes the same arguments as
  Interchange's `runMigrations`: a `DBConfig` and the host schema holding
  `tenant` and `principal`. It applies the SQL files shipped under
  `migrations/`, all idempotent, with no ledger. The `adopt` option,
  `RunArtifactMigrationsOptions`, `MigrationChecksumError` and
  `MigrationAdoptError` are removed, and the `artifacts.migrations` ledger
  table is dropped on the next boot.
- The drizzle tables (`artifact`, `artifactVersion`, `upload`,
  `mailAttachmentRef`) are no longer exported from the package entry. Hosts
  reach artifacts through the routes and functions; `ARTIFACTS_SCHEMA` and the
  `*Row` types stay public.
- The tenant routes take `Hono<TenantEnv>`, read the host-provided tenant and
  principal context natively, and require the host's Interchange `RequireGrant`
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
- `SKILL_DRAFT_KIND` is removed. `skill-draft` is no longer a reserved kind:
  create, list, find-by-title and every read treat it like any other `kind`.
- `web_site` handling is removed: `web_site` content is no longer normalized
  on write, `readArtifact` no longer takes `path` or returns a site summary,
  `artifact_read_chunk` no longer refuses it, and the sidecar's
  `artifact_read` no longer forwards `path`. `WEB_SITE_KIND`,
  `WEB_SITE_MAX_FILES`, `WEB_SITE_MAX_PATH_LENGTH`, `WEB_SITE_MAX_TOTAL_BYTES`,
  `WebSiteContentError`, `normalizeWebSiteContent`, `normalizeWebSitePath`,
  `parseWebSiteContentJson`, `serializeWebSiteContent`,
  `summarizeWebSiteContent`, `WebSiteContent` and `WebSiteReadSummary` are no
  longer exported.
- Mail attachment references are removed: `POST` and `GET
  /instances/:instanceId/mail-attachments`, `saveMailAttachmentRefs`,
  `listMailAttachmentRefs`, `MAIL_ATTACHABLE_KINDS`,
  `MailAttachmentKindError`, `MAX_MAIL_ATTACHMENT_BYTES`,
  `MAX_MAIL_ATTACHMENTS_PER_MAIL` and `MailAttachmentRefRow`. The new
  `0003_drop_mail_attachment_ref` migration drops the `mail_attachment_ref`
  table and its rows.
- `windowContent` is no longer exported; it is internal to the tool reads.

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

[Unreleased]: https://github.com/corbitsdev/corbits-artifacts
[0.1.0]: https://github.com/corbitsdev/corbits-artifacts
