# Architecture

How `@corbits/artifacts` is put together, and where its boundaries are. For
install, the mount snippet, the route table and the response contracts, see the
[package README](./README.md) — this document is about
structure and reasoning, and does not repeat them.

## The shape of the thing

A **library, not a service**. It creates no app, starts no background work, and
opens no pool unless asked. A host calls two functions:

- `runArtifactMigrations(db)` — once at boot, before serving.
- `mountArtifacts(app, opts)` — registers the artifact routes on a Hono app the
  host already built.

## Where the routes are served

The core registers root-relative paths (`/artifacts*`,
`/instances/:id/mail-attachments`) and takes no base path, so the *mount point*
is the host's decision. The convention every `@corbits/*-core` package
documents, and every example here demonstrates, is **`/api`** — the same prefix
Interchange serves its own routes under (`app.route("/api/me", …)`,
`app.route("/api/tenants", …)`). No `/v1` segment, no vendor prefix.

```ts
const api = new Hono<TenantEnv>();
// Host middleware has already placed `tenant` and `principal` on the context.
mountArtifacts(api, { db, contentStore, requireGrant });
app.route("/api", api);
```

which serves `/api/artifacts`, `/api/artifacts/:id`,
`/api/artifacts/:id/versions`, `/api/artifacts/:id/download`, and
`/api/instances/:instanceId/mail-attachments`. Nesting rather than teaching the
core a base path keeps the mount free of a configurable base path.

Everything else it needs arrives through `opts` or the host's request context.
Nothing is reached for.

## The mount seam

`mountArtifacts(app: Hono<TenantEnv>, opts): Hono<TenantEnv>` takes Interchange's
`TenantEnv` so it composes with a host app mounted beneath Interchange auth +
tenant middleware. The host places full `tenant` and `principal` rows on the
context; this package reads them natively and never invents a second principal
resolution path.

Three options have no sensible default — `db`, `contentStore`, `requireGrant` —
and the rest degrade a *feature*, never safety, when omitted. The README's table
of what a minimal host passes is the reference; what matters architecturally is
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

## Three custom seams

Beyond the host's native context and grants, this package exposes **three**
extension seams: the substrate (`ContentStore`), a display-only decorator
(`decorate` / provenance), and a grant-provisioning hook (`onArtifactCreated`).
Authorization is not a custom seam — it is the host's Interchange `RequireGrant`;
`onArtifactCreated` is not authorization either, it is the write side of the
same idea — the host deciding what makes its grant model true, this package
only handing it the row and the scope that made it.

## The options

`ContentStore` is declared in `ports.ts`; the rest are plain `mountArtifacts`
options. Who the request runs as is read from `TenantEnv`, not passed as a
callback.

| Option | What it is for | Default |
| --- | --- | --- |
| `requireGrant` | Host-owned Interchange grant middleware factory. Single-artifact mutations (revise, archive/unarchive, …) run `requireGrant(idResource("artifact", "id"), <action>)`. | none — required |
| `contentStore` | Where an artifact's file bytes live (`ContentStore`). | none — required |
| `decorate` | A **display-only** decorator over serialized rows (provenance labels, host joins). | no-op |
| `onArtifactCreated` | Host hook run inside the same transaction as artifact creation — where a host mints grants for the row it just made. | no-op |

`decorate`'s display-only status is a contract, not a convention: it may add
fields to rows on their way out and must never affect *what* is returned or
*who* may see it. Joining a host's workflow tables inside this package would
couple it to a schema it must not know, so the host supplies the decorator.
Clients that need an owner display name resolve `ownerPrincipalId` themselves;
this package never ships directory names on the wire.

### Grant provisioning (`onArtifactCreated`)

Checking a grant (`requireGrant`) and minting one (`onArtifactCreated`) are the
same host responsibility looked at from both ends: this package neither
invents authorization policy nor decides who a newly created row belongs to
for grant purposes — it hands the host the row, inside the transaction that
made it durable, and the host decides.

`examples/reference-host` provisions a real `creator`-origin grant on create —
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

## Modules

| File | Role |
| --- | --- |
| `mount.ts` | HTTP surface: parsing, validation, status codes; reads `TenantEnv` principal; wires host `requireGrant`. |
| `artifacts.ts` | The core domain — create, revise, find-or-version, list, get, archive, serialize. |
| `uploads.ts` | `createFileArtifact`, the MIME policies, and the size caps. |
| `download.ts` | One download path over the three storage conventions. |
| `content-store.ts` | The two shipped `ContentStore` implementations. |
| `tools.ts` | Agent-facing tool definitions and windowed artifact reads (caller tenant only). |
| `web-site.ts` | The `web-site` kind's content encoding and validation. |
| `mail-attachments.ts` | Artifact↔message associations. |
| `ports.ts` | The `ContentStore` type and the shared `ResolvedPrincipal` shape. |
| `schema.ts` / `migrations.ts` | The four tables, and the DDL that creates them. |

## Data model

Four physical tables — `artifact`, `artifact_version`, `upload`,
`mail_attachment_ref` — plus this package's own migration ledger.

**Hard control-plane foreign keys, by design.** `tenant_id` is `NOT NULL` and
references `public.tenant(id)` (`ON DELETE CASCADE` — a deleted tenant takes its
artifacts with it) and `principal_id` / `owner_principal_id` reference
`public.principal(id)` (`ON DELETE SET NULL` — a removed principal detaches its
artifacts rather than destroying them). This package is coupled to Interchange:
it mounts on Interchange-shaped hosts only, and the host's own migrations must
have run before `runArtifactMigrations`. The internal key —
`artifact_version.artifact_id` — cascades with its artifact.

**Cheap row-local CHECKs.** `artifact.version` and `artifact_version.version`
must be ≥ 1; `upload.size` and `mail_attachment_ref.size` must be ≥ 0. These are
single-column constraints applied by a ledgered migration — free at write time.

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
New kinds cost no migration. What is *not* free-form is the import allowlist:
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
duplicates. Uniqueness on that triple is a property of the *find-or-version
pattern specifically*, not an invariant of the table, so it does not belong
in the schema — it belongs exactly where it now lives, inside the one code
path that promises it.

Separately, this package also has no way to confirm existing tenants are
already free of duplicate `(title, kind)` rows, which would make even a
scoped constraint risky to backfill. That is not the main reason for
rejecting the constraint, and it is not by itself decisive. See
`0003_schema_invariants` for this repo's own pattern for guarding a
migration against exactly that kind of bad existing data.

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
its own find-then-create against a *different* lock is not serialized
against this one — the primitive closes the race for its own call path, not
for every possible way to write an artifact.

**`upload` is never a standalone resource.** There is no `POST /uploads`; every
upload eagerly mints its artifact, and the row is reachable only through
`source.upload.id`. `mail_attachment_ref` carries no bytes at all — the file
already *is* an artifact, and the ref only records which artifacts rode with
which message.

The list index is `(tenant_id, updated_at, id)`. The `id` is the list's
tie-break and must be *in* the index, or the keyset cursor's row-value
comparison falls out of the index condition into a filter and drags a sort
behind it.

## Migrations

`runArtifactMigrations(db)` is idempotent and safe to call unconditionally on
every boot of every replica.

- The whole run is one transaction whose first statements are
  `SET LOCAL client_min_messages = warning` and a **transaction-scoped**
  advisory lock. A transaction pins one pooled connection, so the lock, the
  ledger read and the DDL are the same session; the lock releases on commit or
  rollback, so there is no unlock call to lose on an error path.
  `CREATE TABLE IF NOT EXISTS` is not itself race-safe, so the lock — not the
  `IF NOT EXISTS` — is what makes concurrent cold starts safe.
- Lowering `client_min_messages` is why a re-run prints **nothing**: every
  statement is `IF NOT EXISTS`, and on the second boot Postgres answers each with
  a NOTICE that postgres.js would otherwise dump to the console, making a clean
  re-boot look like a wall of errors. `SET LOCAL` scopes it to the transaction
  and stops at NOTICE — WARNING and above still reach the host.
- Each migration applies inside a nested transaction (a savepoint) together with
  its ledger row, so a migration can never be recorded as applied with only some
  of its statements run.
- The ledger is this package's own table, `artifacts.migrations`,
  never shared with a host's. Each row records a **checksum of the migration's
  rendered SQL**, so editing a shipped migration fails with
  `MigrationChecksumError` on the next boot instead of letting existing and
  fresh databases diverge silently. Ship a new migration instead. The column is
  `NOT NULL`, so the guarantee is unconditional: there is no unrecorded row for
  the runner to adopt and wave through.
- Event timestamps (`created_at`, `updated_at`, `archived_at`) are
  **`timestamptz`**. The initial create migration still lays them down as
  zoneless `timestamp`; a follow-on migration retypes them with
  `USING col AT TIME ZONE 'UTC'`, treating existing walls as the UTC clocks the
  package always assumed. List keyset cursors project through
  `AT TIME ZONE 'UTC'` and compare with `::timestamptz`, so paging and date
  filters stay on the absolute instant under any session `TimeZone`. Rollback is
  the reverse cast (`TYPE timestamp USING col AT TIME ZONE 'UTC'`) plus a new
  ledgered migration — never edit a shipped one.
- A later ledgered migration sets `artifact.tenant_id NOT NULL` and adds the
  version/size CHECKs. If null-tenant rows still exist, that migration raises
  before altering the column so the operator can clean them up first.
- Empty ledger + pre-existing package objects fails closed
  (`MigrationAdoptError`). `{ adopt: true }` records checksums without re-DDL
  only after shape validation: tables, column types, required nullability, and
  the named CHECK constraints. Column presence alone is not enough.

**The package owns its own Postgres schema.** Every table, index and the ledger
live in `artifacts`, created by the runner and qualified in every
DDL statement and every query — nothing resolves through `search_path`, so the
package shares a database with the host's control plane without ever being able
to collide with (or silently adopt) a host table of the same name. The coupling
to the host is explicit instead: `tenant_id` and the principal columns are hard
FKs into `public.tenant` / `public.principal` (see the data model).

## Boundaries

Owned by this package: the four tables and their migrations; the HTTP surface,
its validation and its status codes; the version and archive semantics; the
upload **gate** (`createFileArtifact` takes `policy` as a required argument and
refuses anything outside it before the `ContentStore` is touched); and the
download path with its `nosniff`/`attachment` behaviour.

Supplied by the host: the `Hono<TenantEnv>` app and the database handle; the
authenticated `tenant`/`principal` on the request context; the host's
`RequireGrant`; display-only provenance decoration; and a `ContentStore`.

## Known limits

- **No file parsing, ever.** No PDF parser, no spreadsheet parser, no text
  extractor, and none is planned. An extractor is a heavyweight, fast-moving
  native dependency, and what the extracted text is *for* is the host's product.
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
- **One 404 covers four causes** for a resolved caller — never minted,
  malformed, a `skill-draft`, or another tenant's. Distinguishing them would be
  an existence oracle. Expect no more detail than that from the API.
