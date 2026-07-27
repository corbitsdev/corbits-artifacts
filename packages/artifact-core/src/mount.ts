import { type } from "arktype";
import type { Context, Env, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { ArtifactDb } from "./db.js";
import {
  ArtifactFilterError,
  ArtifactNotFoundError,
  createArtifact,
  enrich,
  getArtifact,
  listArtifacts,
  listArtifactVersions,
  serializeArtifact,
  setArtifactArchived,
  SKILL_DRAFT_KIND,
  writeArtifactVersion,
  type ListArtifactsFilters,
  type SerializedArtifact,
} from "./artifacts.js";
import { resolveDownload } from "./download.js";
import {
  listMailAttachmentRefs,
  saveMailAttachmentRefs,
  SaveMailAttachmentRefsSchema,
} from "./mail-attachments.js";
import type { ArtifactRow } from "./schema.js";
import {
  denyAllAdminAuthz,
  noProvenance,
  type AdminAuthz,
  type ResolvedPrincipal,
  type ContentStore,
  type Provenance,
} from "./ports.js";
import {
  ARTIFACT_UPLOAD_POLICY,
  createFileArtifact,
  effectiveUploadMime,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
  type UploadPolicy,
} from "./uploads.js";

export type MountArtifactsOpts = {
  db: ArtifactDb;
  contentStore: ContentStore;
  /**
   * Who the request runs as. `ctx` is `unknown` on purpose — the seam never
   * reaches into Hono's context typing — and the signature is identical to
   * `@corbits/mailbox-core`'s, so a host mounting both passes the same function.
   *
   * The resolved tenant is authoritative: there is no caller-supplied tenant
   * override, so a request can only ever reach the tenant its own session
   * resolves to.
   */
  resolvePrincipal: (
    ctx: unknown,
  ) => Promise<ResolvedPrincipal | null> | ResolvedPrincipal | null;
  /** Seam A. Defaults to nobody being an admin and no cross-tenant reads. */
  adminAuthz?: AdminAuthz;
  /** Seam C, display-only. Defaults to no decoration. */
  provenance?: Provenance;
  /** Which files `POST /artifacts/upload` accepts. */
  uploadPolicy?: UploadPolicy;
};

// Trim before validating, so a whitespace-only field is rejected and the parsed
// value carries no surrounding space.
const TrimmedNonEmpty = type("string")
  .pipe((raw: string) => raw.trim())
  .to("string > 0");

/**
 * Kinds the human import path may mint. An explicit kind must stay inside this
 * allowlist so an untrusted caller cannot stamp a file-shaped, downloadable
 * kind onto a row whose content is actually a URL or a pasted body.
 */
export const IMPORTABLE_ARTIFACT_KINDS = ["link", "document"] as const;

const CreateArtifactRequest = type({
  mode: "'url' | 'text'",
  title: TrimmedNonEmpty,
  content: TrimmedNonEmpty,
  "kind?": type.enumerated(...IMPORTABLE_ARTIFACT_KINDS),
});

const ReviseArtifactRequest = type({
  "title?": TrimmedNonEmpty,
  "content?": TrimmedNonEmpty,
});

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

/**
 * Mount the artifact routes onto a host Hono app.
 *
 * Generic over `E extends Env` and returning `Hono<E>` so it composes with a
 * host app that carries its own environment (an Interchange `createApp`
 * returns `Hono<AppEnv>`, not a bare `Hono`).
 *
 * With no resolvable principal, collection reads answer an empty 200 while
 * detail reads and mutations answer 403 — the same rule every `@corbits/*-core`
 * package follows. See "The no-identity contract" in the README for why.
 */
export function mountArtifacts<E extends Env>(
  app: Hono<E>,
  opts: MountArtifactsOpts,
): Hono<E> {
  const {
    db,
    contentStore,
    resolvePrincipal,
    adminAuthz = denyAllAdminAuthz,
    provenance = noProvenance,
    uploadPolicy = ARTIFACT_UPLOAD_POLICY,
  } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the handler
  // context is the host's, never this package's, so it stays untyped here and
  // is handed to `resolvePrincipal` as `unknown`.
  type Ctx = Context<any, any, any>;

  const scopeFor = (c: Ctx) => resolvePrincipal(c);

  async function serialize(
    scope: ResolvedPrincipal,
    rows: ArtifactRow[],
  ): Promise<SerializedArtifact[]> {
    const serialized = rows.map(serializeArtifact);
    await enrich(provenance, scope.tenantId, serialized);
    return serialized;
  }

  /**
   * Serialize AFTER a write has committed. Enrichment is display-only and runs
   * against host-supplied seams: if one throws here, the row is already durable
   * and a 500 would be a lie — the client would retry a mutation that already
   * succeeded, forever. Undecorated rows are the correct degraded answer.
   */
  async function serializeCommitted(
    scope: ResolvedPrincipal,
    rows: ArtifactRow[],
  ): Promise<SerializedArtifact[]> {
    try {
      return await serialize(scope, rows);
    } catch {
      return rows.map(serializeArtifact);
    }
  }

  /**
   * Load an artifact and confirm the caller may see it, or produce the reply.
   *
   * EVERY single-artifact route funnels through here, which is what makes
   * "skill-draft is not-found everywhere" true rather than repeated:
   * the kind is filtered at the one choke point, so read, version history,
   * revise, archive/unarchive and download all answer 404 without any of them
   * having to remember to. A skill-draft is an agent's private scratch buffer;
   * it is never addressable, and a 403 would confirm the id exists.
   *
   * FOUR WAYS TO NOT GET AN ARTIFACT, ONE ANSWER. For a caller who HAS a
   * principal, these are indistinguishable — same status, same body:
   *
   *   - the id was never minted,
   *   - the id is not even shaped like an id,
   *   - the row is a skill-draft, and
   *   - the row belongs to another tenant.
   *
   * The last one used to answer `403 Forbidden` while the first answered `404`,
   * which made this route an existence oracle: anyone with an account could
   * walk arbitrary UUIDs and learn which ones name a real artifact SOMEWHERE in
   * the deployment, tenant boundary notwithstanding. That contradicted the very
   * doctrine written above this function — "whether that resource exists is not
   * the caller's to learn" — so the code moved to match the doctrine, not the
   * other way round.
   *
   * The signed-out 403 is NOT an exception to that, and this is why the scope
   * is resolved FIRST: a caller with no principal is refused before any id is
   * looked at, so the 403 is a statement about the caller and separates no two
   * ids from each other. Resolving first is also what keeps an unauthenticated
   * request from reaching the database at all.
   */
  async function loadScoped(
    c: Ctx,
  ): Promise<
    | { row: ArtifactRow; scope: ResolvedPrincipal }
    | { response: Response }
  > {
    const scope = await scopeFor(c);
    if (!scope) return { response: c.json({ error: "Forbidden" }, 403) };

    const row = await getArtifact(db, c.req.param("id")!);
    if (!row || row.kind === SKILL_DRAFT_KIND || row.tenantId !== scope.tenantId) {
      return { response: c.json({ error: "Artifact not found" }, 404) };
    }
    return { row, scope };
  }

  app.get(
    "/artifacts",
    describeRoute({
      tags: ["Artifacts"],
      summary: "List artifacts in the caller's tenant",
      description:
        "Newest-updated first by default. Supports query/kind/owner/creatorKind/date filters, an `updatedAt__id` keyset cursor, and an archived-only toggle. skill-draft artifacts are never listed.",
      parameters: [
        { name: "query", in: "query", required: false, schema: { type: "string" } },
        { name: "sort", in: "query", required: false, schema: { type: "string" } },
        { name: "kind", in: "query", required: false, schema: { type: "string" } },
        {
          name: "ownerPrincipalId",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "creatorKind",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["user", "agent"] },
        },
        {
          name: "createdAfter",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "createdBefore",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        { name: "cursor", in: "query", required: false, schema: { type: "string" } },
        { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        {
          name: "archived",
          in: "query",
          required: false,
          schema: { type: "boolean" },
        },
      ],
      responses: {
        200: { description: "A page of artifacts" },
        400: { description: "Invalid filter or cursor" },
        403: { description: "Tenant not accessible" },
      },
    }),
    async (c) => {
      const creatorKind = c.req.query("creatorKind");
      if (creatorKind !== undefined && creatorKind !== "user" && creatorKind !== "agent") {
        return c.json({ error: "Invalid creatorKind filter" }, 400);
      }
      const scope = await scopeFor(c);
      if (!scope) return c.json({ artifacts: [], nextCursor: null });

      const filters: ListArtifactsFilters = {
        archived: c.req.query("archived") === "true",
        ...(c.req.query("query") !== undefined ? { query: c.req.query("query") } : {}),
        ...(c.req.query("sort") !== undefined ? { sort: c.req.query("sort") } : {}),
        ...(c.req.query("kind") !== undefined ? { kind: c.req.query("kind") } : {}),
        ...(c.req.query("ownerPrincipalId") !== undefined
          ? { ownerPrincipalId: c.req.query("ownerPrincipalId") }
          : {}),
        ...(creatorKind !== undefined ? { creatorKind } : {}),
        ...(c.req.query("createdAfter") !== undefined
          ? { createdAfter: c.req.query("createdAfter") }
          : {}),
        ...(c.req.query("createdBefore") !== undefined
          ? { createdBefore: c.req.query("createdBefore") }
          : {}),
        ...(c.req.query("cursor") !== undefined ? { cursor: c.req.query("cursor") } : {}),
        ...(c.req.query("limit") !== undefined
          ? { limit: Number(c.req.query("limit")) }
          : {}),
      };

      try {
        const page = await listArtifacts(db, scope.tenantId, filters);
        return c.json({
          artifacts: await serialize(scope, page.rows),
          nextCursor: page.nextCursor,
        });
      } catch (err) {
        if (err instanceof ArtifactFilterError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    },
  );

  app.post(
    "/artifacts",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Import an artifact from an external source (link a URL or paste text)",
      description:
        "`mode: url` links an external page (content is the URL, origin `imported`); `mode: text` stores a pasted body (origin `manual`). The artifact and its version 1 are written in one transaction.",
      responses: {
        201: { description: "Artifact created" },
        400: { description: "Invalid request body" },
        403: { description: "Tenant not accessible" },
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => null);
      if (raw === null) return c.json({ error: "Invalid JSON body" }, 400);
      const body = CreateArtifactRequest(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);

      if (body.mode === "url") {
        let url: URL;
        try {
          url = new URL(body.content);
        } catch {
          return c.json({ error: "content must be a valid URL" }, 400);
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return c.json({ error: "URL must be http or https" }, 400);
        }
      }

      const scope = await scopeFor(c);
      if (!scope) return c.json({ error: "Tenant not accessible" }, 403);

      const isUrl = body.mode === "url";
      const row = await db.transaction((tx) =>
        createArtifact(tx, {
          scope,
          ownerPrincipalId: scope.principalId,
          creatorKind: "user",
          kind: body.kind ?? (isUrl ? "link" : "document"),
          title: body.title,
          content: body.content,
          source: isUrl
            ? { origin: "imported", url: body.content }
            : { origin: "manual" },
        }),
      );

      const [artifactJson] = await serializeCommitted(scope, [row]);
      return c.json({ artifact: artifactJson }, 201);
    },
  );

  app.post(
    "/artifacts/upload",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Import files as artifacts",
      description:
        "multipart/form-data with one or more File fields (single, batch, or folder). Each file's bytes go to the configured ContentStore and eagerly become an artifact plus its version 1 — there is no standalone upload resource.",
      responses: {
        201: { description: "Artifacts created" },
        400: { description: "No files supplied" },
        403: { description: "Tenant not accessible" },
        413: { description: "Too many files, or a file/aggregate over the limit" },
        415: { description: "A file has an unsupported type" },
      },
    }),
    async (c) => {
      const scope = await scopeFor(c);
      if (!scope) return c.json({ error: "Tenant not accessible" }, 403);

      const parsed = await c.req.parseBody({ all: true });
      const files: File[] = [];
      let generatedBy: string | undefined;
      for (const value of Object.values(parsed)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry instanceof File) files.push(entry);
          else if (typeof entry === "string" && generatedBy === undefined) {
            const trimmed = entry.trim();
            if (trimmed.length > 0) generatedBy = trimmed;
          }
        }
      }

      if (files.length === 0) {
        return c.json({ error: "Expected at least one file field" }, 400);
      }
      if (files.length > MAX_UPLOAD_FILE_COUNT) {
        return c.json(
          {
            error: `Too many files: ${files.length} exceeds the ${MAX_UPLOAD_FILE_COUNT} file limit`,
          },
          413,
        );
      }

      // Validate every file BEFORE reading any bytes into memory, so an
      // oversized batch is refused without buffering it.
      let totalBytes = 0;
      for (const file of files) {
        if (file.size > MAX_UPLOAD_BYTES) {
          return c.json(
            { error: `File "${file.name}" exceeds the ${MAX_UPLOAD_BYTES} byte limit` },
            413,
          );
        }
        totalBytes += file.size;
        if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
          return c.json(
            {
              error: `Upload exceeds the ${MAX_UPLOAD_TOTAL_BYTES} byte aggregate limit`,
            },
            413,
          );
        }
        if (effectiveUploadMime(file, uploadPolicy).length === 0) {
          return c.json({ error: `File "${file.name}" has an unsupported type` }, 415);
        }
      }

      const ownerPrincipalId = scope.principalId;
      const rows = await db.transaction(async (tx) => {
        const created: ArtifactRow[] = [];
        for (const file of files) {
          created.push(
            await createFileArtifact(tx, contentStore, {
              scope,
              ownerPrincipalId,
              creatorKind: "user",
              filename: file.name,
              mimeType: effectiveUploadMime(file, uploadPolicy),
              policy: uploadPolicy,
              bytes: new Uint8Array(await file.arrayBuffer()),
              ...(generatedBy !== undefined ? { generatedBy } : {}),
            }),
          );
        }
        return created;
      });

      return c.json({ artifacts: await serializeCommitted(scope, rows) }, 201);
    },
  );

  app.get(
    "/artifacts/:id",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Read one artifact (deep link)",
      description:
        "Deliberately does NOT filter archived: archiving is a soft-hide from discovery, not an access revocation, and the detail view must load an archived artifact to offer unarchive.",
      parameters: [idParam],
      responses: {
        200: { description: "The artifact" },
        403: { description: "No resolvable principal" },
        404: {
          description:
            "Artifact not found — also the answer for a malformed id, a skill-draft, and another tenant's artifact",
        },
      },
    }),
    async (c) => {
      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;
      const [artifactJson] = await serialize(loaded.scope, [loaded.row]);
      return c.json({ artifact: artifactJson });
    },
  );

  app.get(
    "/artifacts/:id/versions",
    describeRoute({
      tags: ["Artifacts"],
      summary: "List an artifact's version history",
      parameters: [idParam],
      responses: {
        200: { description: "Versions, newest first" },
        403: { description: "No resolvable principal" },
        404: { description: "Artifact not found" },
      },
    }),
    async (c) => {
      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;
      return c.json({ versions: await listArtifactVersions(db, loaded.row.id) });
    },
  );

  app.post(
    "/artifacts/:id/versions",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Revise an artifact, creating a new version",
      description:
        "Locks the row FOR UPDATE and bumps version by one; a unique (artifactId, version) index backstops a racing writer. Archived and skill-draft artifacts present as not found.",
      parameters: [idParam],
      responses: {
        200: { description: "New version created" },
        400: { description: "Invalid request body" },
        403: { description: "No resolvable principal" },
        404: { description: "Artifact not found" },
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => null);
      if (raw === null) return c.json({ error: "Invalid JSON body" }, 400);
      const body = ReviseArtifactRequest(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
      if (body.title === undefined && body.content === undefined) {
        return c.json(
          { error: "Provide content and/or title to revise the artifact" },
          400,
        );
      }

      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;
      try {
        return c.json(
          await writeArtifactVersion(db, {
            scope: loaded.scope,
            artifactId: loaded.row.id,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.content !== undefined ? { content: body.content } : {}),
          }),
        );
      } catch {
        return c.json({ error: "Artifact not found" }, 404);
      }
    },
  );

  /**
   * Archive is the only surface that consults the authz seam. Allowed for the
   * principal-exact owner, or for whatever else the host's `canAdminister`
   * chooses to allow (a tenant admin, or the member who owns the agent that
   * produced it) — called only after the exact-owner match already failed.
   */
  async function setArchived(c: Ctx, archive: boolean) {
    const loaded = await loadScoped(c);
    if ("response" in loaded) return loaded.response;
    const { row, scope } = loaded;

    let allowed = row.ownerPrincipalId === scope.principalId;
    if (!allowed) {
      allowed = await adminAuthz.canAdminister(scope, {
        ownerPrincipalId: row.ownerPrincipalId,
      });
    }
    if (!allowed) return c.json({ error: "Forbidden" }, 403);

    const updated = await setArtifactArchived(db, row, archive);
    const [artifactJson] = await serializeCommitted(scope, [updated]);
    return c.json({ artifact: artifactJson });
  }

  app.post(
    "/artifacts/:id/archive",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Archive (soft-hide) an artifact",
      description:
        "Sets archived_at so the artifact disappears from listings, search, and agent tools. Nothing is destroyed and it stays reachable by direct link. Idempotent; reversible via unarchive.",
      parameters: [idParam],
      responses: {
        200: { description: "Artifact archived" },
        403: { description: "Forbidden" },
        404: { description: "Artifact not found" },
      },
    }),
    (c) => setArchived(c, true),
  );

  app.post(
    "/artifacts/:id/unarchive",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Unarchive an artifact",
      description: "Clears archived_at so the artifact reappears in listings. Idempotent.",
      parameters: [idParam],
      responses: {
        200: { description: "Artifact unarchived" },
        403: { description: "Forbidden" },
        404: { description: "Artifact not found" },
      },
    }),
    (c) => setArchived(c, false),
  );

  app.get(
    "/artifacts/:id/download",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Download an artifact's content",
      description:
        "One path over three storage conventions, in precedence order: out-of-band ContentStore blob, inline data: URL (file/image kinds), then downloadable text (csv-export). Served as an attachment except a PDF with ?inline=1; X-Content-Type-Options: nosniff always.",
      parameters: [
        idParam,
        { name: "inline", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        200: { description: "The file body" },
        400: { description: "Artifact kind is not downloadable" },
        403: { description: "No resolvable principal" },
        404: { description: "Artifact not found" },
      },
    }),
    async (c) => {
      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;

      const result = await resolveDownload(
        db,
        contentStore,
        loaded.row,
        c.req.query("inline") === "1",
      );
      if ("status" in result) return c.json({ error: result.error }, result.status);

      c.header("Content-Type", result.mimeType);
      c.header("X-Content-Type-Options", "nosniff");
      c.header(
        "Content-Disposition",
        `${result.disposition}; filename="${result.filename}"`,
      );
      return typeof result.body === "string"
        ? c.body(result.body)
        : c.body(result.body.buffer as ArrayBuffer);
    },
  );

  app.post(
    "/instances/:instanceId/mail-attachments",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Associate file artifacts with a sent message",
      description:
        "Records which artifacts were attached to a message so a transcript can rehydrate its chips after reload. No bytes move — the files are already artifacts. Idempotent per (mailId, artifactId).",
      parameters: [
        { name: "instanceId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        201: { description: "References recorded" },
        400: { description: "Invalid request body" },
        403: { description: "Tenant not accessible" },
        404: { description: "A referenced artifact is not visible to the caller" },
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => null);
      const body = SaveMailAttachmentRefsSchema(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
      const scope = await scopeFor(c);
      if (!scope) return c.json({ error: "Tenant not accessible" }, 403);
      try {
        await saveMailAttachmentRefs(db, {
          scope,
          instanceId: c.req.param("instanceId")!,
          body,
        });
      } catch (err) {
        // Same body as every detail route, so naming another tenant's artifact
        // here is indistinguishable from naming one that never existed.
        if (err instanceof ArtifactNotFoundError) {
          return c.json({ error: "Artifact not found" }, 404);
        }
        throw err;
      }
      return c.json({}, 201);
    },
  );

  app.get(
    "/instances/:instanceId/mail-attachments",
    describeRoute({
      tags: ["Artifacts"],
      summary: "List artifact↔message associations for an instance",
      parameters: [
        { name: "instanceId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        200: { description: "All references for this instance" },
      },
    }),
    async (c) => {
      // A collection read, so the no-member asymmetry makes this an empty 200:
      // a caller with no resolvable principal has no references, which is a
      // fact, not a refusal. It names no artifact, so answering leaks nothing.
      const scope = await scopeFor(c);
      if (!scope) return c.json({ refs: [] });
      return c.json({
        refs: await listMailAttachmentRefs(db, scope, c.req.param("instanceId")!),
      });
    },
  );

  return app;
}
