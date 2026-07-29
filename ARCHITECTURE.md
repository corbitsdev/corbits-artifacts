# Architecture

How `@corbits/artifacts` is put together, and where its boundaries are. For
install, the mount snippet, the route table and the response contracts, see the
[package README](./packages/artifacts/README.md) — this document is about
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

Everything else it needs arrives through `opts`. Nothing is reached for.

## The mount seam

`mountArtifacts<E extends Env>(app: Hono<E>, opts): Hono<E>` is generic over the
host's Hono `Env`, so it composes with an app that carries its own environment
rather than requiring a bare `Hono`.

Three options have no sensible default — `db`, `contentStore`,
`resolvePrincipal` — and the rest degrade a *feature*, never safety, when
omitted. The README's table of what a minimal host passes is the reference; what
matters architecturally is that every default **fails closed**: no `isAdmin`
means nobody is an admin, no `identity` means no directory and no cross-tenant
reads, no `decorate` means no decoration.

What the package does **not** require of a host: no auth middleware, no session
library, no UI. What it DOES require: Interchange's control plane —
`public.tenant` and `public.principal` must exist before the migrations run,
because the tables carry hard foreign keys into them.

`resolvePrincipal`'s signature is identical across the Corbits cores, so a host
mounting more than one passes the same function to each. The resolved tenant is
authoritative — there is no caller-supplied tenant override anywhere in the
route surface.

## The options

`ContentStore` and `Identity` are types declared in `ports.ts`; the rest are
plain `mountArtifacts` options. `resolvePrincipal` takes the host's request
context as `unknown`.

| Option | What it is for | Default |
| --- | --- | --- |
| `resolvePrincipal` | Who the request runs as. Reads the host session; returns `null` when signed out. | none — required |
| `contentStore` | Where an artifact's file bytes live (`ContentStore`). | none — required |
| `isAdmin` | Whether a principal is a tenant admin. Only archive/unarchive consults it. | nobody is an admin |
| `identity` | Owner display names, the agent→human ownership resolution, creator-kind principal sets, and cross-tenant membership (`Identity`). | `anonymousIdentity` |
| `decorate` | A **display-only** decorator over serialized rows. | no-op |

`decorate`'s display-only status is a contract, not a convention: it may add
fields to rows on their way out and must never affect *what* is returned or
*who* may see it. Joining a host's workflow tables inside this package would
couple it to a schema it must not know, so the host supplies the decorator.

`Identity.ownerIsMemberOfTenant` gates cross-tenant reads and must fail closed;
the shipped `anonymousIdentity` does.

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
| `ports.ts` | The `ContentStore` and `Identity` types, and the fail-closed `anonymousIdentity` default. |
| `schema.ts` / `migrations.ts` | The four tables, and the DDL that creates them. |

## Data model

Four physical tables — `artifact`, `artifact_version`, `upload`,
`mail_attachment_ref` — plus this package's own migration ledger.

**Hard control-plane foreign keys, by design.** `tenant_id` references
`public.tenant(id)` (`ON DELETE CASCADE` — a deleted tenant takes its artifacts
with it) and `principal_id` / `owner_principal_id` reference
`public.principal(id)` (`ON DELETE SET NULL` — a removed principal detaches its
artifacts rather than destroying them). This package is coupled to Interchange:
it mounts on Interchange-shaped hosts only, and the host's own migrations must
have run before `runArtifactMigrations`. The internal key —
`artifact_version.artifact_id` — cascades with its artifact.

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
