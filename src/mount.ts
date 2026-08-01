import "./arktype.js";
import { type } from "arktype";
import type { Context, Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { idResource, type RequireGrant, type TenantEnv } from "@intx/hub-api";
import type { ArtifactDb } from "./db.js";
import {
  ArtifactNotFoundError,
  ArtifactSizeError,
  createArtifact,
  enrich,
  getArtifact,
  listArtifacts,
  ListArtifactsQuery,
  listArtifactVersions,
  ListArtifactVersionsQuery,
  MAX_ARTIFACT_CONTENT_BYTES,
  serializeArtifact,
  serializeArtifactListItem,
  setArtifactArchived,
  SKILL_DRAFT_KIND,
  writeArtifactVersion,
  type ArtifactListRow,
  type SerializedArtifact,
  type SerializedArtifactBase,
  type SerializedArtifactListItem,
} from "./artifacts.js";
import { resolveDownload } from "./download.js";
import {
  listMailAttachmentRefs,
  MailAttachmentKindError,
  saveMailAttachmentRefs,
  SaveMailAttachmentRefsSchema,
} from "./mail-attachments.js";
import type { ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal, ContentStore } from "./ports.js";
import {
  ARTIFACT_UPLOAD_POLICY,
  contentDispositionHeader,
  createFileArtifact,
  effectiveUploadMime,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
  UnsupportedUploadTypeError,
  type UploadPolicy,
} from "./uploads.js";
import { WebSiteContentError } from "./web-site.js";

export type MountArtifactsOpts = {
  db: ArtifactDb;
  contentStore: ContentStore;
  /**
   * The host's grant middleware factory (Interchange `createRequireGrant`).
   * Authorize is the host's responsibility: artifact-core implements no owner,
   * agent-owner, membership, or admin policy. The mutating routes that act on
   * one artifact are guarded with `requireGrant(idResource("artifact", "id"),
   * <action>)`.
   */
  requireGrant: RequireGrant;
  /**
   * A DISPLAY-ONLY decorator: it may add fields to the serialized rows and
   * must never affect what is returned or who may see it. Defaults to a no-op.
   * Receives list items (no `content`) on `GET /artifacts` and full detail rows
   * (with `content`) on single-artifact surfaces.
   */
  decorate?: (
    tenantId: string,
    rows: readonly SerializedArtifactBase[],
  ) => Promise<void>;
  /** Which files `POST /artifacts/upload` accepts. */
  uploadPolicy?: UploadPolicy;
};

// Trim before validating, so a whitespace-only field is rejected and the parsed
// value carries no surrounding space.
const TrimmedNonEmpty = type("string")
  .pipe((raw: string) => raw.trim())
  .to("string > 0");

const HttpUrl = TrimmedNonEmpty.narrow((content, ctx) => {
  let url: URL;
  try {
    url = new URL(content);
  } catch {
    return ctx.mustBe("a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return ctx.mustBe("an http or https URL");
  }
  return true;
});

/**
 * `kind` and `mode` must agree: only a URL may mint a `link` (whose content
 * downstream UIs treat as navigable), and a URL never mints a `document` whose
 * content would be a bare URL masquerading as a body — so each branch admits
 * only its own kind, and any other kind is unrepresentable.
 */
const CreateArtifactRequest = type({
  mode: "'url'",
  title: TrimmedNonEmpty,
  content: HttpUrl,
  "kind?": "'link'",
}).or({
  mode: "'text'",
  title: TrimmedNonEmpty,
  content: TrimmedNonEmpty,
  "kind?": "'document'",
});

// A non-string (or missing/blank) field carries no provenance rather than
// erroring, so a stray file part named `generatedBy` is ignored.
const GeneratedByField = type("unknown")
  .pipe((raw) => {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  })
  .to("string <= 200 | undefined");

const ReviseArtifactRequest = type({
  "title?": TrimmedNonEmpty,
  "content?": TrimmedNonEmpty,
}).narrow(
  (body, ctx) =>
    body.title !== undefined ||
    body.content !== undefined ||
    ctx.mustBe("a body with content and/or title"),
);

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

/**
 * Mount the artifact routes onto a host Hono app.
 *
 * Takes `Hono<TenantEnv>` so it composes with a host app mounted beneath
 * Interchange's auth + tenant middleware, which puts the resolved `tenant` and
 * `principal` on the context. The host owns principal resolution and grants;
 * this package reads the principal from context and authorizes the mutating
 * routes through the host's `requireGrant`.
 *
 * With no principal on the context, collection reads answer an empty 200 while
 * detail reads and mutations answer 403 — the same rule every `@corbits/*-core`
 * package follows. See "No principal on the context" in the README for why.
 */
export function mountArtifacts(
  app: Hono<TenantEnv>,
  opts: MountArtifactsOpts,
): Hono<TenantEnv> {
  const {
    db,
    contentStore,
    requireGrant,
    decorate = async () => {},
    uploadPolicy = ARTIFACT_UPLOAD_POLICY,
  } = opts;

  // The handler context is TenantEnv. `principal` (and `tenant`) is placed by
  // Interchange's middleware; nothing here resolves it.
  type Ctx = Context<TenantEnv, any, any>;

  /**
   * Read the authenticated principal the host placed on the context. Returns
   * null when the host's auth/tenant middleware did not resolve one — the
   * signed-out case each route class handles per the no-principal contract.
   */
  const scopeFor = (c: Ctx): ResolvedPrincipal | null => {
    const principal = c.get("principal");
    if (!principal) return null;
    return { tenantId: principal.tenantId, principalId: principal.id };
  };

  const readJson = (c: Ctx): Promise<unknown> => c.req.json().catch(() => null);

  /**
   * Reject the request when the host has not put a principal on the context.
   * Must run BEFORE `requireGrant`: Interchange's middleware reads
   * `principal.id` without its own null guard, so on an unresolved context it
   * throws and the host sees a 500 rather than the 403 this package answers
   * everywhere else for a signed-out caller.
   */
  const principalRequired: MiddlewareHandler<TenantEnv> = async (c, next) => {
    if (!c.get("principal")) return c.json({ error: "Forbidden" }, 403);
    await next();
  };

  /**
   * Coarse HTTP body ceiling for JSON mutators, reusing the content-byte constant.
   * Only acts when Content-Length is present; missing length still streams into
   * `readJson`, so hosts must set a global request body limit upstream.
   */
  function contentLengthOverCeiling(c: Ctx): boolean {
    const raw = c.req.header("content-length");
    if (raw === undefined || raw === "") return false;
    const n = Number(raw);
    return Number.isFinite(n) && n > MAX_ARTIFACT_CONTENT_BYTES;
  }

  async function serialize(
    scope: ResolvedPrincipal,
    rows: ArtifactRow[],
  ): Promise<SerializedArtifact[]> {
    const serialized = rows.map(serializeArtifact);
    await enrich(decorate, scope.tenantId, serialized);
    return serialized;
  }

  /** List is discovery: metadata + enrichment, never the body. */
  async function serializeList(
    scope: ResolvedPrincipal,
    rows: ArtifactListRow[],
  ): Promise<SerializedArtifactListItem[]> {
    const serialized = rows.map(serializeArtifactListItem);
    await enrich(decorate, scope.tenantId, serialized);
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
   * Every single-artifact route funnels through here: no principal answers 403
   * before any id is looked at (collection reads instead answer an empty 200).
   * A missing id, a malformed id, a skill-draft, and another tenant's artifact
   * all collapse to the same 404 so the route is not an existence oracle.
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
        "Newest-updated first by default. Supports query/kind/owner/date filters, an `updatedAt__id` keyset cursor, and an archived-only toggle. skill-draft artifacts are never listed. List is discovery only: each item omits `content` (fetch the body via GET /artifacts/:id, download, or tools).",
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
        200: {
          description:
            "A page of artifacts without full `content` (metadata only; use detail/download/tools for bodies)",
        },
        400: { description: "Invalid filter or cursor" },
        403: { description: "Tenant not accessible" },
      },
    }),
    async (c) => {
      const filters = ListArtifactsQuery(c.req.query());
      if (filters instanceof type.errors) {
        return c.json({ error: filters.summary }, 400);
      }
      const scope = await scopeFor(c);
      if (!scope) return c.json({ artifacts: [], nextCursor: null });

      const page = await listArtifacts(db, scope.tenantId, filters);
      return c.json({
        artifacts: await serializeList(scope, page.rows),
        nextCursor: page.nextCursor,
      });
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
        413: { description: "Declared Content-Length over the content ceiling" },
      },
    }),
    async (c) => {
      // Principal before body: unauthenticated callers get 403 without learning
      // whether the JSON was well-formed.
      const scope = await scopeFor(c);
      if (!scope) return c.json({ error: "Tenant not accessible" }, 403);
      if (contentLengthOverCeiling(c)) {
        return c.json(
          {
            error: `Request body exceeds the ${MAX_ARTIFACT_CONTENT_BYTES} byte limit`,
          },
          413,
        );
      }

      const raw = await readJson(c);
      if (raw === null) return c.json({ error: "Invalid JSON body" }, 400);
      const body = CreateArtifactRequest(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);

      const isUrl = body.mode === "url";
      try {
        const row = await db.transaction((tx) =>
          createArtifact(tx, {
            scope,
            ownerPrincipalId: scope.principalId,
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
      } catch (error) {
        if (error instanceof ArtifactSizeError) {
          return c.json({ error: error.message }, 400);
        }
        if (error instanceof WebSiteContentError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    },
  );

  app.post(
    "/artifacts/upload",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Import files as artifacts",
      description:
        "multipart/form-data with one or more File fields (single, batch, or folder). An optional `generatedBy` text field (≤200 chars) is recorded as display-only provenance. Each file's bytes go to the configured ContentStore and eagerly become an artifact plus its version 1 — there is no standalone upload resource.",
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
      for (const value of Object.values(parsed)) {
        for (const entry of Array.isArray(value) ? value : [value]) {
          if (entry instanceof File) files.push(entry);
        }
      }
      // Only the named field carries provenance — any other stray text field
      // is ignored, so a client cannot smuggle a label in by accident.
      const generatedBy = GeneratedByField(parsed["generatedBy"]);
      if (generatedBy instanceof type.errors) {
        return c.json({ error: "generatedBy must be 200 characters or fewer" }, 400);
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

      // Validate every file before the copy/decode work below. `parseBody` has
      // already buffered the request, so this bounds what proceeds past here —
      // hosts should still set their own request body limit upstream.
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
      }

      // `createFileArtifact` is the single MIME authority: an unsupported type
      // throws there, the transaction rolls back, and no artifact row survives.
      const ownerPrincipalId = scope.principalId;
      let rows: ArtifactRow[];
      try {
        rows = await db.transaction(async (tx) => {
          const created: ArtifactRow[] = [];
          for (const file of files) {
            created.push(
              await createFileArtifact(tx, contentStore, {
                scope,
                ownerPrincipalId,
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
      } catch (err) {
        if (err instanceof UnsupportedUploadTypeError) {
          return c.json({ error: err.message }, 415);
        }
        throw err;
      }

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
      description:
        "Newest first. Paginated with the same limit defaults as list (cursor is the last version number returned).",
      parameters: [idParam],
      responses: {
        200: { description: "Versions page, newest first" },
        400: { description: "Invalid cursor or limit" },
        403: { description: "No resolvable principal" },
        404: { description: "Artifact not found" },
      },
    }),
    async (c) => {
      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;
      const query = ListArtifactVersionsQuery(c.req.query());
      if (query instanceof type.errors) {
        return c.json({ error: query.summary }, 400);
      }
      return c.json(await listArtifactVersions(db, loaded.row.id, query));
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
        400: { description: "Invalid request body or content" },
        403: { description: "No resolvable principal, or not permitted" },
        404: { description: "Artifact not found" },
        413: { description: "Declared Content-Length over the content ceiling" },
      },
    }),
    principalRequired,
    requireGrant(idResource("artifact", "id"), "write"),
    async (c) => {
      // loadScoped resolves the principal before any body parse.
      const loaded = await loadScoped(c);
      if ("response" in loaded) return loaded.response;
      if (contentLengthOverCeiling(c)) {
        return c.json(
          {
            error: `Request body exceeds the ${MAX_ARTIFACT_CONTENT_BYTES} byte limit`,
          },
          413,
        );
      }

      const raw = await readJson(c);
      if (raw === null) return c.json({ error: "Invalid JSON body" }, 400);
      const body = ReviseArtifactRequest(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
      try {
        return c.json(
          await writeArtifactVersion(db, {
            scope: loaded.scope,
            artifactId: loaded.row.id,
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.content !== undefined ? { content: body.content } : {}),
          }),
        );
      } catch (error) {
        if (error instanceof ArtifactNotFoundError) {
          return c.json({ error: "Artifact not found" }, 404);
        }
        if (error instanceof ArtifactSizeError) {
          return c.json({ error: error.message }, 400);
        }
        if (error instanceof WebSiteContentError) {
          return c.json({ error: error.message }, 400);
        }
        throw error;
      }
    },
  );

  async function setArchived(c: Ctx, archive: boolean) {
    const loaded = await loadScoped(c);
    if ("response" in loaded) return loaded.response;
    const { row, scope } = loaded;

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
    principalRequired,
    requireGrant(idResource("artifact", "id"), "archive"),
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
    principalRequired,
    requireGrant(idResource("artifact", "id"), "archive"),
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
        contentDispositionHeader(result.disposition, result.filename),
      );
      if (typeof result.body === "string") return c.body(result.body);
      // Slice out exactly this view's bytes: `.buffer` alone would send the
      // whole underlying ArrayBuffer, and a ContentStore returning a pooled
      // Buffer (nonzero byteOffset) would leak adjacent, unrelated memory.
      const { buffer, byteOffset, byteLength } = result.body;
      return c.body(buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer);
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
        400: {
          description:
            "Invalid request body, or a referenced artifact is not an attachable file/image kind",
        },
        403: { description: "Tenant not accessible" },
        404: { description: "A referenced artifact is not visible to the caller" },
        413: { description: "Declared Content-Length over the content ceiling" },
      },
    }),
    async (c) => {
      const scope = await scopeFor(c);
      if (!scope) return c.json({ error: "Tenant not accessible" }, 403);
      if (contentLengthOverCeiling(c)) {
        return c.json(
          {
            error: `Request body exceeds the ${MAX_ARTIFACT_CONTENT_BYTES} byte limit`,
          },
          413,
        );
      }
      const raw = await readJson(c);
      const body = SaveMailAttachmentRefsSchema(raw);
      if (body instanceof type.errors) return c.json({ error: body.summary }, 400);
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
        // Visible but wrong kind: the id is real to this tenant, so 400 rather
        // than collapsing into the 404 existence oracle.
        if (err instanceof MailAttachmentKindError) {
          return c.json({ error: err.message }, 400);
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
