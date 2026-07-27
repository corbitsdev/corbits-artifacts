# @corbits/artifact-core

Artifacts, versions and file uploads as a mountable module for any Interchange host.
Backend only — this package ships no UI.

`mountArtifacts(app, opts)` adds routes to a Hono app you already have. It never
creates the app, opens a pool, or reaches for a session — the host owns all three and
hands them in.

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the data model, the ports, and the
design rationale behind them.

## Requirements

| | |
| --- | --- |
| Runtime | Node 22+ or Bun 1.1+ |
| Postgres | 13+ (`gen_random_uuid()`) |
| Minimum `@intx/*` | **0.2.2** — 0.1.2 does not install (its deps pin the unpublished `@intx/*@0.0.0`) and ships raw TypeScript |

Peer dependencies: `hono`, `hono-openapi`, `drizzle-orm`, `postgres`, `arktype`,
`@intx/types`. They are peers rather than pinned deps because each is shared runtime
state — a Hono app, a drizzle handle, a module-global registry — and a second copy in
the tree does not error, it silently misbehaves.

Your **host** additionally needs `@intx/hub-api`, `@intx/db`, `@intx/hub-sessions` and
`@intx/hub-common` for `createApp`. This module imports none of them, so they are not
peers here and npm will not warn you they are missing.

## Install

```bash
npm install @corbits/artifact-core \
  hono hono-openapi drizzle-orm postgres arktype @intx/types@^0.2.2
```

> **Not on npm yet.** Until the first release, consume it from a git checkout or an
> `npm pack` tarball. The `@intx/*` packages *are* published, at `0.2.2`.

## Mount

```ts
import { Hono } from "hono";
import type { AppEnv } from "@intx/hub-api";
import {
  InlineContentStore,
  mountArtifacts,
  runArtifactMigrations,
  type ResolvedPrincipal,
} from "@corbits/artifact-core";

// Boot-time, once. Idempotent — safe on every boot of every replica.
await runArtifactMigrations(hub.db);

const api = new Hono<AppEnv>();
mountArtifacts(api, {
  db: hub.db,
  contentStore: InlineContentStore,
  resolvePrincipal(ctx): ResolvedPrincipal | null {
    const user = (ctx as Context<AppEnv>).get("user");
    if (!user) return null;
    return { tenantId: user.tenantId, principalId: user.id };
  },
});
app.route("/api", api);
```

Routes are registered root-relative and served under `/api` — the prefix Interchange
serves its own routes under. No `/v1`, no vendor prefix.

`examples/reference-host` in this repository is a complete `@intx/hub-api` host with
this module mounted and the acceptance suite pointed at it. Start there if you need the
whole `createApp` wiring.

## The seams

TWO seams — authorization and provenance. `?creatorKind=` needs no seam at all: it is a
denormalized column set once, from the caller's own scope, at write time.

Two options have no sensible default; the rest fail closed and degrade a *feature*,
never safety.

| Option | Required | Default and what omitting it costs |
| --- | --- | --- |
| `db` | **yes** | The drizzle handle the host already has |
| `contentStore` | **yes** | `InlineContentStore` for a minimal host |
| `resolvePrincipal` | **yes** | `(ctx: unknown) => { tenantId, principalId } \| null`. Identical to `@corbits/mailbox-core`'s, so a host mounting both passes one function to both. The resolved tenant is authoritative — no caller-supplied override. |
| `adminAuthz` (Seam A) | no | `denyAllAdminAuthz` — nobody is an admin and no tenant may read another's artifacts. Nothing becomes more permissive. |
| `provenance` (Seam B) | no | `noProvenance` — rows carry no decoration. Display-only by contract, so it can never change what is returned or who sees it. |
| `uploadPolicy` | no | `ARTIFACT_UPLOAD_POLICY` — the standard document/image/spreadsheet allowlist. |

`AdminAuthz` answers two verdicts, both fail-closed:

```ts
type AdminAuthz = {
  // Called only after the core has already granted the exact-owner match, so
  // a host implementation covers whatever else it wants to allow — a tenant
  // admin, or the human member behind the agent that owns the row.
  canAdminister(scope: ResolvedPrincipal, row: { ownerPrincipalId: string | null }): Promise<boolean>;
  // The gate on a cross-tenant artifact_read.
  canReadTenant(scope: ResolvedPrincipal, targetTenantId: string): Promise<boolean>;
};
```

## Routes

| Surface | Behavior |
| --- | --- |
| `GET /api/artifacts` | Tenant-scoped list; query/kind/owner/creatorKind/date filters, keyset cursor, archived toggle |
| `POST /api/artifacts` | Human import — link a URL or paste text |
| `POST /api/artifacts/upload` | multipart import. An optional `generatedBy` form field is stored as `source.generatedBy`, a free-form display label nothing here reads back |
| `GET /api/artifacts/:id` | Deep link (archived artifacts still load) |
| `GET`/`POST /api/artifacts/:id/versions` | Version history and revision |
| `POST /api/artifacts/:id/(un)archive` | Idempotent soft-hide |
| `GET /api/artifacts/:id/download` | One path over three storage conventions |
| `…/api/instances/:id/mail-attachments` | Artifact↔message associations |

Every route carries `describeRoute`, so it appears in the host's `/openapi.json`.

### Two response contracts

**No resolvable principal** — the cross-core rule every `@corbits/*` package follows, so
a host mounting several hands its client one policy rather than three:

| Route class | Response | In this core |
| --- | --- | --- |
| List / count / aggregate reads | **empty `200`** | `GET /api/artifacts` → `{"artifacts":[],"nextCursor":null}`; `GET …/mail-attachments` → `{"refs":[]}` |
| Streams, detail reads, mutations | **`403`** | every other route |

A collection read answers the truth and names no resource. Everything else names a
specific resource, and whether it exists is not an unresolvable caller's to learn. This
core exposes no stream today; the class is listed so a future one is classified by the
rule rather than by guesswork.

**Once a principal is resolved**, four causes collapse into one `404
{"error":"Artifact not found"}` on all six single-artifact routes: the id was never
minted, the id is not shaped like an id, the row is a `skill-draft`, or the row belongs
to another tenant. A cross-tenant `403` would be an existence oracle — any account
holder could walk ids and learn which name a real artifact somewhere in the deployment.

Archive/unarchive still answer `403` for a caller who can see the artifact but may not
administer it: an authorization decision about a row known to exist, not a disclosure.

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
      creatorKind: "user",
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

Four tables — `artifact`, `artifact_version`, `upload`, `mail_attachment_ref` — with
zero control-plane foreign keys; tenant and principal are held by value.

`runArtifactMigrations(db)` is idempotent, advisory-locked, and keeps its own ledger
(`corbits_artifact_core_migrations`). Call it unconditionally on every boot of every
replica: concurrent cold starts serialize on a transaction-scoped advisory lock, and a
re-run prints nothing.

## Development

```bash
bun run test          # dep-guard, then the suite (needs Postgres)
bun run test:coverage
bun run build         # dist/ — JS + .d.ts, consumable from Node
```

The tarball ships `src/` alongside `dist/`, so the emitted `.js.map` and `.d.ts.map`
resolve: go-to-definition and stack traces land on real TypeScript.

`examples/reference-host` mounts this module on a real `@intx/hub-api` app and asserts
the acceptance scenarios end to end — `bun run test:acceptance` from the repo root.

## License

LGPL-2.1-only. See [LICENSE](./LICENSE).
