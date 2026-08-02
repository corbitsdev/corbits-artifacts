# @corbits/artifacts

Artifacts, versions and file uploads as a mountable module for any Interchange host.
Backend only — this package ships no UI.

`mountArtifacts(app, opts)` adds routes to a Hono app you already have. It never
creates the app, opens a pool, or reaches for a session — the host owns all three and
hands them in.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model, the mount options, and the
design rationale behind them.

## Requirements

| | |
| --- | --- |
| Runtime | Node 22+ or Bun 1.1+ |
| Postgres | 13+ (`gen_random_uuid()`) |
| Minimum `@intx/*` | **0.2.2** |

Peer dependencies: `hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`,
`@intx/types`, `@intx/hub-api`. They are peers rather than pinned deps because each is
shared runtime state — a Hono app, a drizzle handle, Interchange's `TenantEnv` /
`RequireGrant`, a module-global registry — and a second copy in the tree does not
error, it silently misbehaves.

Your **host** additionally needs `@intx/db`, `@intx/hub-sessions` and
`@intx/hub-common` for `createApp`. This module imports none of them, so they are not
peers here and npm will not warn you they are missing.

## Install

```bash
# From git (Bun)
bun add github:corbitsdev/corbits-artifacts

# Or with peers explicitly
bun add github:corbitsdev/corbits-artifacts \
  hono hono-openapi drizzle-orm postgres arktype \
  @intx/types@^0.2.2 @intx/hub-api@^0.2.2
```

```bash
# npm / pack
npm install @corbits/artifacts \
  hono hono-openapi drizzle-orm postgres arktype \
  @intx/types@^0.2.2 @intx/hub-api@^0.2.2
```

> **Not on npm yet.** Until the first release, consume it from git or an `npm pack`
> tarball. The `@intx/*` packages *are* published, at `0.2.2`. This repository root *is*
> the package, so git installs resolve cleanly.

## Mount

```ts
import { Hono } from "hono";
import { createRequireGrant, type TenantEnv } from "@intx/hub-api";
import {
  InlineContentStore,
  mountArtifacts,
  runArtifactMigrations,
} from "@corbits/artifacts";

// Boot-time, once. Idempotent — safe on every boot of every replica.
await runArtifactMigrations(hub.db);

// Host middleware places Interchange `tenant` and `principal` on the context
// before these routes run. Mount takes Hono<TenantEnv> and reads them natively.
const api = new Hono<TenantEnv>();
const requireGrant = createRequireGrant({ grantStore, conditionRegistry });
mountArtifacts(api, {
  db: hub.db,
  contentStore: InlineContentStore,
  requireGrant,
});
app.route("/api", api);
```

Routes are registered root-relative and served under `/api` — the prefix Interchange
serves its own routes under. No `/v1`, no vendor prefix.

`examples/reference-host` in this repository is a complete `@intx/hub-api` host with
this module mounted and the acceptance suite pointed at it. Start there if you need the
whole `createApp` wiring, including host middleware that sets `tenant`/`principal` and
a host-owned `RequireGrant`.

## The options

Three options have no sensible default; the rest fail closed and degrade a *feature*,
never safety.

| Option | Required | Default and what omitting it costs |
| --- | --- | --- |
| `db` | **yes** | The drizzle handle the host already has |
| `contentStore` | **yes** | `InlineContentStore` for a minimal host |
| `requireGrant` | **yes** | The host's Interchange grant middleware factory. Archive/unarchive and other single-artifact mutations authorize through `requireGrant(idResource("artifact", "id"), …)`. This package implements no owner, agent-owner, membership, or admin policy. |
| `decorate` | no | No-op — rows carry no decoration. Display-only by contract, so it can never change what is returned or who sees it. Clients resolve display names from `ownerPrincipalId` when they need them. |
| `onArtifactCreated` | no | No-op. Runs inside the same transaction as artifact creation, once per row — the seam a host uses to provision grants (e.g. a `creator`-origin grant on `artifact:<id>` for `write`/`archive`) for the row it just made. See `examples/reference-host`'s `grantOwnership` for a worked example against a real grant store. |
| `uploadPolicy` | no | `ARTIFACT_UPLOAD_POLICY` — the standard document/image/spreadsheet allowlist. |

Who the request runs as is **not** an option: the host's auth/tenant middleware puts
`tenant` and `principal` on the `TenantEnv` context, and this package reads them. No
principal on the context is the signed-out case (empty collection reads, `403`
everywhere else).

### Compatibility

`MountArtifactsOpts` follows semver: breaking changes to option names or shapes only
happen in major versions.

## Routes

| Surface | Behavior |
| --- | --- |
| `GET /api/artifacts` | Tenant-scoped list; query/kind/owner/date filters, keyset cursor, archived toggle. **Discovery only:** each item omits `content` (fetch bodies via detail, download, or tools) |
| `POST /api/artifacts` | Human import — link a URL or paste text |
| `POST /api/artifacts/upload` | multipart import. An optional `generatedBy` form field is stored as `source.generatedBy`, a free-form display label nothing here reads back |
| `GET /api/artifacts/:id` | Deep link (archived artifacts still load) |
| `GET`/`POST /api/artifacts/:id/versions` | Version history (paginated, no content bodies) and revision |
| `POST /api/artifacts/:id/(un)archive` | Idempotent soft-hide |
| `GET /api/artifacts/:id/download` | One path over three storage conventions |
| `…/api/instances/:id/mail-attachments` | Artifact↔message associations |

Every route carries `describeRoute`, so it appears in the host's `/openapi.json`.

**List contract (minor client break):** `GET /api/artifacts` (and `listArtifacts` /
`serializeArtifactListItem`) no longer include full `content` on each item. Clients that
previously rendered list rows from the list payload must load bodies via
`GET /api/artifacts/:id`, download, or the read tools. Search still matches title and
content server-side; only the response projection changes.

**Version history pagination:** `GET /api/artifacts/:id/versions` returns
`{ versions, nextCursor }` with the same default/max limit clamps as list. Cursor is the
last version number returned (newest-first). Version rows omit content; use
`GET /api/artifacts/:id?version=N` (or `getArtifactVersion`) for a pinned body.

**Write size limits:** create and revise reject titles longer than 512 characters and
content larger than 15 MiB UTF-8 (`ArtifactSizeError` / HTTP 400). JSON mutators also
refuse a declared `Content-Length` over that same 15 MiB ceiling with HTTP 413 before
buffering the body; missing `Content-Length` still streams into the parser. **Hosts
should set a global request body limit upstream** of this mount (Hono middleware, Bun
server, reverse proxy) — the package check is a best-effort edge guard, not a substitute
for a host-level cap. Upload byte caps remain on the multipart path.

**Auth before body:** mutating JSON routes (`POST /api/artifacts`,
`POST /api/artifacts/:id/versions`, `POST …/mail-attachments`) read the principal from
context before parsing the body, so an unauthenticated caller gets 403 without learning
whether the JSON was well-formed. Upload already auth'd first. Single-artifact write
routes run existence/tenant/skill-draft resolution (the same check `loadScoped` does)
before the host's `requireGrant`, and only run `requireGrant` once that has confirmed a
real, visible row — so `requireGrant` is answering "is this permitted," never "does this
exist," and a caller who cannot see the row gets `404` however a real grant evaluator
would answer for it.

### Two response contracts

**No principal on the context** — the cross-core rule every `@corbits/*` package
follows, so a host mounting several hands its client one policy rather than three:

| Route class | Response | In this core |
| --- | --- | --- |
| List / count / aggregate reads | **empty `200`** | `GET /api/artifacts` → `{"artifacts":[],"nextCursor":null}`; `GET …/mail-attachments` → `{"refs":[]}` |
| Streams, detail reads, mutations | **`403`** | every other route |

A collection read answers the truth and names no resource. Everything else names a
specific resource, and whether it exists is not an unresolvable caller's to learn. This
core exposes no stream today; the class is listed so a future one is classified by the
rule rather than by guesswork.

**Once a principal is on the context**, four causes collapse into one `404
{"error":"Artifact not found"}` on all six single-artifact routes: the id was never
minted, the id is not shaped like an id, the row is a `skill-draft`, or the row belongs
to another tenant. A cross-tenant `403` would be an existence oracle — any account
holder could walk ids and learn which name a real artifact somewhere in the deployment.

Archive/unarchive still answer `403` when the host's `requireGrant` denies the
`archive` action on a row the caller can see: an authorization decision about a row
known to exist, not a disclosure.

## Uploads: three allowlists, and who owns each

Three surfaces mint file artifacts, each with its own explicit allowlist. Collapsing
them into one global list would silently widen the narrow ones.

| Policy | Surface | Owner |
| --- | --- | --- |
| `ARTIFACT_UPLOAD_POLICY` | Gallery import — `POST /api/artifacts/upload` | this package |
| `SPREADSHEET_UPLOAD_POLICY` | Spreadsheet ingest | the host |
| `PARSED_DOCUMENT_POLICY` | Chat/mail attachment divert | the host |

What this package owns is the **gate**: `createFileArtifact` — the one function every
file artifact goes through — takes `policy` as a required argument and refuses anything
outside it with `UnsupportedUploadTypeError` before the `ContentStore` is touched. A
host route cannot mint a file artifact without naming the surface it is minting it for.

```ts
// Parse BEFORE calling, so a parse failure leaves no orphan artifact.
const parsed = await parseAttachment(file);
try {
  await db.transaction((tx) =>
    createFileArtifact(tx, contentStore, {
      scope,
      ownerPrincipalId: scope.principalId,
      filename: file.name,
      mimeType: file.type,
      bytes,
      policy: PARSED_DOCUMENT_POLICY,
    }),
  );
} catch (err) {
  if (err instanceof UnsupportedUploadTypeError) return c.json({ error: err.message }, 415);
  throw err;
}
```

**File parsing is the host's, deliberately.** This package ships no PDF, spreadsheet or
document text extractor and will not grow one: an extractor is a heavyweight fast-moving
native dependency, and what the extracted text is *for* is the host's product. Of "parse
a PDF and serve it inline", the inline half is ours and is covered by the acceptance
suite. The contract owed to a parsing host is **parse before you store** — then a
failure leaves no orphan artifact and no orphan bytes, and a success writes bytes, row
and version 1 in one transaction.

## ContentStore

Where file bytes live is a port. Two impls ship and both pass the same suite:
`InlineContentStore` (bytea side-table, referenced by `source.upload.id`) and
`DataUrlContentStore` (bytes inline in `content` as a data: URL). An asset-substrate
backend is a third impl, not a rewrite.

The single download path resolves the conventions in precedence order — out-of-band
blob, then inline data URL, then downloadable text (`csv-export`). Bytes are served as
`attachment` with `X-Content-Type-Options: nosniff`, except a PDF requested `?inline=1`.

## Schema and migrations

Four tables — `artifact`, `artifact_version`, `upload`, `mail_attachment_ref` — in the
package-owned `artifacts` Postgres schema. `tenant_id` is required (`NOT NULL`) and,
with the principal columns, is a hard foreign key into Interchange's
`public.tenant` / `public.principal`, so the host's own migrations must run first.
Version columns CHECK ≥ 1; size columns CHECK ≥ 0. Whether a principal belongs to
the stamped tenant is **host-owned** via the middleware that places `tenant` and
`principal` on the request context — the package does not install multi-table triggers
for that alignment (see ARCHITECTURE.md).

`runArtifactMigrations(db)` is idempotent, advisory-locked, creates and owns the
`artifacts` Postgres schema, and keeps its own ledger
(`artifacts.migrations`). Call it unconditionally on every boot of every
replica: concurrent cold starts serialize on a transaction-scoped advisory lock, and a
re-run prints nothing.

If the ledger is empty but package tables already exist (restored dump, dropped
ledger), the runner fails closed with `MigrationAdoptError`. Operators who have
confirmed the live schema may pass `{ adopt: true }` to record checksums without
re-running DDL. Adopt validates tables, column types, `artifact.tenant_id NOT NULL`,
and the named version/size CHECK constraints — not a columns-only glance.

Event timestamps are `timestamptz` so list keyset cursors and date filters stay
stable under a non-UTC session `TimeZone`. A ledgered retype migration converts
legacy zoneless columns with `USING col AT TIME ZONE 'UTC'` (existing walls were
always documented as UTC). Do not edit shipped migrations to roll back — ship a
new reverse cast if you must.

## Working on it

```sh
bun install
docker run -d --name corbits-artifact-pg -p 5457:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=artifact_core postgres:16

# The package suite TRUNCATEs tables and some migration tests DROP SCHEMA.
# Both refuse unless you opt in and the database name is allowlisted.
export ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1

bun run test             # dependency check, then unit + integration
bun run build            # dist/ (JS + .d.ts)
bun run test:acceptance  # builds, then the acceptance scenarios
```

`test:acceptance` builds first because the reference host consumes the built `dist` the
way a real consumer would — running it against stale output is how a green acceptance
run stops meaning anything.

Tests and the example expect
`postgres://postgres:postgres@localhost:5457/artifact_core`; override with
`ARTIFACT_DATABASE_URL`. Destructive package tests additionally require
`ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` and an allowlisted database name
(`artifact_core`, or any name ending in `_test`).

| Requirement | Value |
| --- | --- |
| Opt-in env | `ALLOW_DESTRUCTIVE_ARTIFACT_TESTS=1` (exactly `"1"`) |
| Database name allowlist | `artifact_core` (the documented local docker default), **or** any name ending in `_test` (e.g. `artifacts_test`) |

Point `ARTIFACT_DATABASE_URL` at an allowlisted ephemeral database. A missing opt-in
or a production-looking name throws before any TRUNCATE/DROP runs. The gate is pure
URL/env parsing, so its unit tests do not need a live Postgres.

| | |
| --- | --- |
| `src/` | The published package. Owns `artifact`, `artifact_version`, `upload` and `mail_attachment_ref`. |
| `examples/reference-host` | Mounts it on a real `@intx/hub-api` app against a live Postgres and asserts the acceptance scenarios end to end. |

Strict TypeScript, arktype at boundaries, drizzle for data access. The package owns
the `artifacts` Postgres schema — all four tables and the migration ledger live there,
so sibling cores and host tables never collide. No `@workbench/*` imports anywhere —
`scripts/check-deps.ts` fails the build on any import of that unpublished scope (it runs
in `pretest` and CI).

The tarball ships `src/` alongside `dist/`, so the emitted `.js.map` and `.d.ts.map`
resolve: go-to-definition and stack traces land on real TypeScript.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
