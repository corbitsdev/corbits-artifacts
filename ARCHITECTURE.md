# Architecture

How `@corbits/artifact-core` is put together, and where its boundaries are. For
install, the mount snippet, the route table and the response contracts, see the
[package README](./packages/artifact-core/README.md) — this document is about
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
const api = new Hono<AppEnv>();
mountArtifacts(api, { db, contentStore, resolvePrincipal });
app.route("/api", api);
```

which serves `/api/artifacts`, `/api/artifacts/:id`,
`/api/artifacts/:id/versions`, `/api/artifacts/:id/download`, and
`/api/instances/:instanceId/mail-attachments`. Nesting rather than teaching the
core a base path keeps the frozen `mountX<E extends Env>(app, opts) => Hono<E>`
seam untouched.

Everything else it needs arrives through `opts`. Nothing is reached for; the
dep-guard enforces that mechanically.

## The mount seam

`mountArtifacts<E extends Env>(app: Hono<E>, opts): Hono<E>` is generic over the
host's Hono `Env`, so it composes with an app that carries its own environment
rather than requiring a bare `Hono`.

Three options have no sensible default — `db`, `contentStore`,
`resolvePrincipal` — and the rest degrade a *feature*, never safety, when
omitted. The README's table of what a minimal host passes is the reference; what
matters architecturally is that every default **fails closed**: no `adminAuthz`
means nobody is an admin and no tenant may read another's artifacts, no
`provenance` means no decoration.

What the package does **not** require of a host: no auth middleware, no session
library, no particular schema, no control-plane tables, no id scheme, no UI.

`resolvePrincipal`'s signature is identical across the Corbits cores, so a host
mounting more than one passes the same function to each. The resolved tenant is
authoritative — there is no caller-supplied tenant override anywhere in the
route surface.

## The ports

Four host seams. Three are types declared in `ports.ts`; `resolvePrincipal` is a
`mountArtifacts` option, typed at the mount boundary because it takes the host's
request context as `unknown`. Every optional seam has a **named, exported**
default.

| Seam | What it is for | Default |
| --- | --- | --- |
| `resolvePrincipal` | Who the request runs as. Reads the host session; returns `null` when signed out. | none — required |
| `ContentStore` | Where an artifact's file bytes live. | none — required |
| `AdminAuthz` (Seam A) | Authorization: who may administer (archive/unarchive) a row they do not exactly own, and who may cross a tenant boundary to read. | `denyAllAdminAuthz` |
| `Provenance` (Seam B) | A **display-only** decorator over serialized rows. | `noProvenance` |

TWO seams, not three. There is no directory port: owner display names are
gone from the serialized row entirely, and `?creatorKind=` is answered by a
denormalized column (`artifact.creator_kind`) set once, from the caller's own
scope, at write time — never resolved by a host lookup, so there is nothing
here for a host to skip and silently return zero rows for.

Seam B's display-only status is a contract, not a convention: it may add
fields to rows on their way out and must never affect *what* is returned or
*who* may see it. That is why provenance is a port at all — joining a host's
workflow tables to decorate a row would make this package depend on a schema
it must not know, and the dep-guard fails the build on exactly that.

`AdminAuthz` answers two independent verdicts, both must fail closed:

- `canAdminister(scope, row)` — called only after the core has already
  granted the exact-owner match, so a host's implementation covers whatever
  else it wants to allow (a tenant admin, or the human member behind the agent
  that owns the row).
- `canReadTenant(scope, targetTenantId)` — the gate on a cross-tenant
  `artifact_read`. The shipped `denyAllAdminAuthz` refuses both.

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
| `mount.ts` | HTTP surface: parsing, validation, status codes. |
| `artifacts.ts` | The core domain — create, revise, list, get, archive, serialize. |
| `uploads.ts` | `createFileArtifact`, the MIME policies, and the size caps. |
| `download.ts` | One download path over the three storage conventions. |
| `content-store.ts` | The two shipped `ContentStore` implementations. |
| `tools.ts` | Agent-facing tool definitions and windowed artifact reads. |
| `web-site.ts` | The `web-site` kind's content encoding and validation. |
| `mail-attachments.ts` | Artifact↔message associations. |
| `ports.ts` | Four of the five host seam types, and the three fail-closed defaults. |
| `schema.ts` / `migrations.ts` | The four tables, and the DDL that creates them. |

## Data model

Four physical tables — `artifact`, `artifact_version`, `upload`,
`mail_attachment_ref` — plus this package's own migration ledger.

**Zero control-plane foreign keys.** `tenant_id`, `principal_id` and
`owner_principal_id` are plain `text` held by value. The package must stand up on
a host schema it knows nothing about, so it cannot assume the host has tables by
those names, let alone that their keys are uuids. The only foreign keys are
*internal*: `artifact.parent_id` (self-referential, cascading) and
`artifact_version.artifact_id`.

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

**`parent_id` has no live writer.** It is kept deliberately as the declared
nesting seam: one nullable column and one cascade now, versus a breaking schema
change the moment a host nests.

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
- The ledger is this package's own table, `corbits_artifact_core_migrations`,
  never shared with a host's. Each row records a **checksum of the migration's
  rendered SQL**, so editing a shipped migration fails with
  `MigrationChecksumError` on the next boot instead of letting existing and
  fresh databases diverge silently. Ship a new migration instead. The column is
  `NOT NULL`, so the guarantee is unconditional: there is no unrecorded row for
  the runner to adopt and wave through.

**Mounting under a host's own Postgres schema works.** No DDL and no query here
is schema-qualified, so everything resolves through `search_path`: point a handle
at `search_path=its_schema` and the four tables, their indexes and the ledger are
created there, isolated from the host's own tables. `test/migrations.test.ts`
exercises exactly this against a live database.

## Boundaries

Owned by this package: the four tables and their migrations; the HTTP surface,
its validation and its status codes; the version and archive semantics; the
upload **gate** (`createFileArtifact` takes `policy` as a required argument and
refuses anything outside it before the `ContentStore` is touched); and the
download path with its `nosniff`/`attachment` behaviour.

Supplied by the host: the Hono app and the database handle; who the caller is;
whether they are an admin; the directory, if there is one; provenance
decoration; and a `ContentStore`.

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
