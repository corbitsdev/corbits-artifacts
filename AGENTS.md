# AGENTS.md

## Purpose

`@corbits/artifacts` stores artifacts, their versions and uploads for an
Interchange host. It owns the three tables and their migrations, the HTTP
surface with its validation and status codes, the version and archive
semantics, the upload gate (`createFileArtifact` refuses anything outside its
required `policy` before the `ContentStore` is touched) and the download path
with its `nosniff`/`attachment` behaviour. The host supplies the
`Hono<TenantEnv>` app and database handle, the authenticated tenant and
principal, `RequireGrant`, display-only provenance decoration and a
`ContentStore`.

## Layout

- `src/mount.ts` — `createArtifactRoutes`: parsing, validation, status codes; wires the host's `requireGrant`.
- `src/workflow-mount.ts` — `createWorkflowArtifactRoutes`, the run-scoped routes for callers with no browser session.
- `src/artifacts.ts` — the core domain: create, revise, find-or-version, list, get, archive, serialize.
- `src/uploads.ts` — `createFileArtifact`, the MIME policies and the size caps.
- `src/download.ts` — one download path over the three storage conventions.
- `src/preview.ts`, `src/counts.ts` — previews and segment counts over the list query.
- `src/content-store.ts` — the two shipped `ContentStore` implementations.
- `src/tools.ts` — agent-facing tool definitions and windowed reads (caller tenant only).
- `src/sidecar-bundle.ts` — the `./sidecar-bundle` entry the tool-package loader invokes.
- `src/ports.ts` — the `ContentStore` type and the shared `ResolvedPrincipal` shape.
- `src/schema.ts`, `src/migrations.ts` — the three tables and `runArtifactMigrations`.
- `src/db.ts`, `src/arktype.ts` — the db handle type and arktype config.
- `src/index.ts` — the package entry.
- `e2e/` — real-Postgres suites; `e2e/reference-host.test.ts` runs the acceptance scenarios against `examples/reference-host`.

## Rules

- Nothing is mocked at the database boundary. Destructive test paths refuse to run unless `ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and the database is allowlisted (`artifact_core`, or a name ending in `_test`).
- The coverage floor is 80% of lines and functions per file (`bunfig.toml`); `bun run test:coverage` enforces it.
- A change to the route factory, a port or host wiring is shown working in `examples/reference-host`.
- No `@workbench/*` imports: it is an unpublished scope.
- A new `ContentStore` passes the same suite the shipped ones do, with no special cases.
- `schema.ts` and `migrations/` change together; every migration statement is idempotent and every backfill is cheap once it has run.
- One 404 covers never minted, malformed and another tenant's id; never add an existence oracle.
- Every `any` or cast carries a comment saying why the type system leaves no alternative.

## Internals

### Where the routes are served

The core registers root-relative paths (`/artifacts*`) and takes no base path, so the _mount point_
is the host's decision. The convention every `@corbits/*-core` package
documents, and every example here demonstrates, is **`/api`** — the same prefix
Interchange serves its own routes under (`app.route("/api/me", …)`,
`app.route("/api/tenants", …)`). No `/v1` segment, no vendor prefix.

```ts
// Host middleware has already placed `tenant` and `principal` on the context.
app.route("/api", createArtifactRoutes({ db, contentStore, requireGrant }));
```

which serves `/api/artifacts`, `/api/artifacts/:id`,
`/api/artifacts/:id/versions`, and `/api/artifacts/:id/download`. Returning a sub-app rather than
taking a base path keeps the factory free of a configurable base path.

Everything else it needs arrives through `deps` or the host's request context.
Nothing is reached for.

### The route factory

`createArtifactRoutes(deps): Hono<TenantEnv>` returns a sub-app typed with
Interchange's `TenantEnv`, built the way hub-api's `createGrantRoutes` is, so it
composes beneath Interchange auth + tenant middleware. The host places full
`tenant` and `principal` rows on the context; this package reads them natively
and never invents a second principal resolution path.

Three options have no sensible default — `db`, `contentStore`, `requireGrant` —
and the rest degrade a _feature_, never safety, when omitted. The README's option
tables are the reference; what matters architecturally is
that optional seams **fail closed**: no `decorate` means no decoration.

What the package does **not** require of a host: no session library, no UI, no
directory, no owner/admin policy callback. What it DOES require: Interchange's
control plane — `public.tenant` and `public.principal` must exist before the
migrations run, because the tables carry hard foreign keys into them — and a
host that puts the authenticated principal on `TenantEnv` and hands in its
`RequireGrant`.

The principal's tenant is authoritative — there is no caller-supplied tenant
override anywhere in the route or tool surface. Tool reads always stay inside
`scope.tenantId`.

**This is a decision, not an oversight.** The prior `Identity` port let
`readArtifact` / `readArtifactChunk` take a `tenantId` argument and cross into
it when `identity.ownerIsMemberOfTenant(scope, tenantId)` said the caller's
owner belonged there — a membership check this package invented and owned.
That is exactly the kind of policy this PR removes. It is not replaced by a
grant check, and won't be by a later one either: Interchange's `GrantStore`
resolves a principal's grants **within one tenant**
(`collectGrants(principalId, tenantId)`; `@intx/db`'s implementation filters
`grant` rows by `tenant_id`, and a principal is itself a row scoped to one
tenant). There is no platform primitive for "principal P, home tenant A, holds
a grant readable from tenant B" to check — inventing one here would mean this
package building a second, bespoke cross-tenant authorization concept on top
of the platform's, which is the precise failure mode "authorization is the
host's job" is meant to prevent. If a real product need for cross-tenant
artifact reads shows up, it belongs in Interchange's grant model, not
re-derived per package.

### Three custom seams

Beyond the host's native context and grants, this package exposes **three**
extension seams: the substrate (`ContentStore`), a display-only decorator
(`decorate` / provenance), and a grant-provisioning hook (`onArtifactCreated`).
Authorization is not a custom seam — it is the host's Interchange `RequireGrant`;
`onArtifactCreated` is not authorization either, it is the write side of the
same idea — the host deciding what makes its grant model true, this package
only handing it the row and the scope that made it.

### Row decoration

`decorate`'s display-only status is a contract, not a convention: it may add
fields to rows on their way out and must never affect _what_ is returned or
_who_ may see it. Joining a host's workflow tables inside this package would
couple it to a schema it must not know, so the host supplies the decorator.
Clients that need an owner display name resolve `ownerPrincipalId` themselves;
this package never ships directory names on the wire.

### Grant provisioning (`onArtifactCreated`)

Checking a grant (`requireGrant`) and minting one (`onArtifactCreated`) are the
same host responsibility looked at from both ends: this package neither
invents authorization policy nor decides who a newly created row belongs to
for grant purposes — it hands the host the row, inside the transaction that
made it durable, and the host decides.

Creating needs its own grant, `create` on `artifact:*`, checked before the
body is read; the reference host seeds it for every principal in its tenant.
`examples/reference-host` then provisions a real `creator`-origin grant on create —
`write` and `archive` on `artifact:<id>` for the creating principal, inserted
into Interchange's own `grant` table via `@intx/db`'s schema, in the same
transaction as the artifact row. Its `buildApp`'s default `requireGrant` is the
platform's real `createRequireGrant` over that same table (via
`createGrantStore`), not a stub — a principal with no matching row is refused,
exactly as in production. See `grantOwnership` in
`examples/reference-host/src/index.ts` and the "ownership-derived grants"
scenarios in its acceptance suite for the end-to-end proof: the creator
succeeds, a co-tenant with no grant does not.

### ContentStore

`ContentStore` is the substrate seam:

- `put(tx, scope, blob)` persists bytes **inside the caller's transaction** and
  returns the two artifact-row fields a stored file determines (`content` and
  `source`). Taking the transaction rather than the handle is what makes "bytes,
  artifact row, and version 1" a single atomic write — a failure anywhere leaves
  no orphan bytes and no orphan artifact.
- `get(db, artifact)` resolves **out-of-band** bytes, or `null` when the store
  keeps content in the row itself. It is tenant-scoped: a reference resolving to
  another tenant's bytes must return `null`.

Two implementations ship and both pass the same suite: `InlineContentStore`
(bytes in a tenant-owned `upload` row, referenced by `source.upload.id`) and
`DataUrlContentStore` (bytes inline in `content` as a base64 `data:` URL, no
side-table row, so its `get` returns `null`). A third backend — object storage,
say — is a third implementation, not a rewrite. The single download path
resolves the storage conventions in precedence order rather than branching on
which store is installed.

### Data model

Three physical tables — `artifact`, `artifact_version`, `upload`.

**Hard control-plane foreign keys, by design.** `tenant_id` is `NOT NULL` and
references the host's `tenant(id)` (`ON DELETE CASCADE` — a deleted tenant takes its
artifacts with it) and `principal_id` / `owner_principal_id` reference
the host's `principal(id)` (`ON DELETE SET NULL` — a removed principal detaches its
artifacts rather than destroying them). This package is coupled to Interchange:
it mounts on Interchange-shaped hosts only, and the host's own migrations must
have run before `runArtifactMigrations`. The internal key —
`artifact_version.artifact_id` — cascades with its artifact.

**Cheap row-local CHECKs.** `artifact.version` and `artifact_version.version`
must be ≥ 1; `upload.size` must be ≥ 0. These are
single-column constraints — free at write time.

**Principal↔tenant alignment is host-owned.** The package FKs each column into
the control plane independently; it does **not** enforce that `principal_id` (or
`owner_principal_id`) belongs to the same tenant as `tenant_id`. A multi-table
trigger or composite FK into `public.principal` would couple every write to a
control-plane lookup and is deliberately out of scope. The host's middleware and
context are the authority: routes stamp the `(tenantId, principalId)` pair from
the Interchange `principal` already on `TenantEnv`, so a correctly mounted host
never plants a cross-tenant principal. Operators cleaning legacy rows before the
`tenant_id NOT NULL` migration must assign a valid tenant or delete orphans —
the migration fails with an explicit message if null `tenant_id` rows remain.

**`kind` is free-form text, not a pg enum,** validated at the application edge.
New kinds cost no migration. What is _not_ free-form is the import allowlist:
`POST /api/artifacts` may only mint `link` or `document`, so an untrusted caller
cannot stamp a file-shaped, downloadable kind onto a row whose content is a URL
or a pasted body.

**History is append-only.** Every create and every revision writes an
`artifact_version` row — including version 1, written eagerly with the artifact —
so a version-pinned read always resolves. The version bump has a double guard:
`SELECT ... FOR UPDATE` serializes writers, and the `(artifact_id, version)`
unique constraint makes a racing writer that somehow computed the same next
version fail loudly rather than corrupt history.

**Archival is a soft hide.** `archived_at` null means visible; a timestamp means
hidden from discovery. Deep links to archived artifacts still load.

**Find-or-version is a package primitive, not a constraint.** The only
uniqueness the schema enforces is `(artifact_id, version)` — there is no
constraint on `(tenant_id, title, kind)`, so "find by title, create if
absent, add a version if present" is not naturally atomic: a plain
read-then-write of that pattern races, and two concurrent callers can both
observe NOT FOUND and both create, leaving two artifacts with the same
title.

A uniqueness constraint on `(tenant_id, title, kind)` was considered and
rejected — not just for now, but structurally. `createArtifact` is a
public, unconditional insert with no title lookup of its own, called
directly by the import route, the upload path, and `artifact_link_file`.
Two independent creates sharing a title is normal, intended behavior on
every one of those paths — a coworker uploading `report.pdf` twice, or two
agents each linking a file named `notes.md`, are not bugs. A hard
`UNIQUE(tenant_id, title, kind)` constraint would reject those ordinary
inserts outright, not just gate on a one-time backfill of legacy
duplicates. Uniqueness on that triple is a property of the _find-or-version
pattern specifically_, not an invariant of the table, so it does not belong
in the schema — it belongs exactly where it now lives, inside the one code
path that promises it.

Separately, this package also has no way to confirm existing tenants are
already free of duplicate `(title, kind)` rows, which would make even a
scoped constraint risky to backfill. That is not the main reason for
rejecting the constraint, and it is not by itself decisive.

Instead, `findOrVersionArtifact(db, args)` (in `artifacts.ts`) closes the
race with a transaction-scoped advisory lock keyed by
`hashtext(tenantId, kind, title)`, in its own lock-space namespace (the
two-`int4`-argument form of `pg_advisory_xact_lock`, disjoint from the
single-`bigint` form `runArtifactMigrations` uses). Collision semantics:
whichever concurrent caller acquires the lock first creates the artifact;
every other caller for the identical `(tenantId, kind, title)` blocks, then
finds the row the winner just committed and revises it. Two overlapping
callers always converge on ONE artifact with two versions, never two rows —
callers for a different tenant, kind, or title never contend with each
other. This guarantee holds only for callers that go through
`findOrVersionArtifact`; a caller that instead calls `createArtifact`
directly is unconstrained by design, as above, and a caller that hand-rolls
its own find-then-create against a _different_ lock is not serialized
against this one — the primitive closes the race for its own call path, not
for every possible way to write an artifact.

**`upload` is never a standalone resource.** There is no `POST /uploads`; every
upload eagerly mints its artifact, and the row is reachable only through
`source.upload.id`.

The list index is `(tenant_id, updated_at, id)`. The `id` is the list's
tie-break and must be _in_ the index, or the keyset cursor's row-value
comparison falls out of the index condition into a filter and drags a sort
behind it.

### Migration runner

`runArtifactMigrations(config, { schema })` takes the same arguments as
Interchange's `runMigrations`, and a host calls it right after that, with the
same values. `schema` is where the host's `tenant` and `principal` tables live;
the runner rewrites the `"public".` foreign-key references in the SQL files to
it. It is idempotent and safe to call on every boot of every replica.

- The whole run is one transaction whose first statement takes a
  **transaction-scoped** advisory lock, so the lock releases on commit or
  rollback and there is no unlock call to lose on an error path.
  `CREATE TABLE IF NOT EXISTS` is not itself race-safe, so the lock — not the
  `IF NOT EXISTS` — is what makes concurrent cold starts safe.
- The runner opens its own single-connection client and discards NOTICEs, so a
  re-run, where Postgres answers every `IF NOT EXISTS` with a NOTICE, prints
  nothing.
- Event timestamps (`created_at`, `updated_at`, `archived_at`) are
  **`timestamptz`**. List keyset cursors project through `AT TIME ZONE 'UTC'`
  and compare with `::timestamptz`, so paging and date filters stay on the
  absolute instant under any session `TimeZone`.
- Releases up to 0.1.0 kept a checksum ledger in `artifacts.migrations`.
  `0002_drop_migration_ledger.sql` removes it; a database migrated by 0.1.0
  already has the shape `0001_artifacts.sql` creates, so its statements no-op.

**The package owns its own Postgres schema.** Every table and index lives in
`artifacts`, created by the runner and qualified in every DDL statement and
every query — nothing resolves through `search_path`, so the package shares a
database with the host's control plane without ever being able to collide with
(or silently adopt) a host table of the same name. The coupling to the host is
explicit instead: `tenant_id` and the principal columns are hard FKs into the
host schema's `tenant` / `principal` (see the data model).

### Known limits

- **No file parsing, ever.** No PDF parser, no spreadsheet parser, no text
  extractor, and none is planned. An extractor is a heavyweight, fast-moving
  native dependency, and what the extracted text is _for_ is the host's product.
  The contract the package offers a parsing host instead is **parse before you
  store**: `createFileArtifact` is the only way a file becomes an artifact, so a
  host that parses first and fails leaves nothing orphaned.
- **Two of the three MIME allowlists are host-owned surfaces.** This package
  ships all three constants but only owns the gallery import route; spreadsheet
  ingest and attachment divert are the host's routes calling this package's gate.
- **Upload caps are fixed constants,** not configuration: 10 MB per file, 50
  files and 100 MB per request.
- **`InlineContentStore` keeps bytes in Postgres.** That is a deliberate
  zero-dependency default, not a recommendation at scale; a large corpus wants a
  `ContentStore` over object storage.
- **List paging caps at 100** rows (default 20).
- **One 404 covers three causes** for a resolved caller — never minted,
  malformed, or another tenant's. Distinguishing them would be
  an existence oracle. Expect no more detail than that from the API.

## Local development

```sh
bun install && bun run check
```
