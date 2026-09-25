/**
 * Run-scoped counterpart to the tenant routes in `createArtifactRoutes`, for a
 * host whose workflow-run callers have no browser session and thus no
 * `TenantEnv`/`principal` on the context — a sidecar bearer token + run address
 * instead. The tenant routes themselves have no bearer-token auth surface at
 * all and never will: mixing two unrelated auth conventions into one mount
 * would make each harder to reason about, so this is a second, parallel mount
 * a host wires up only when it actually runs workflows.
 *
 * The host supplies `resolveRunScope`, a function from `(bearerToken,
 * runAddress)` to a resolved run scope or `null` — exactly how it already
 * authenticates its sidecar today; this package trusts whatever it returns
 * and never talks to the host's run/sidecar tables itself.
 *
 * Per-run rate limiting is deliberately NOT implemented here: it stays host
 * side (the host is free to wrap `resolveRunScope`, or the mounted app,
 * however it likes) — this module only draws the auth + CRUD seam.
 */
import { type } from "arktype";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  ArtifactNotFoundError,
  createArtifact,
  findArtifactByTitle,
  getArtifact,
  listArtifacts,
  MetadataShape,
  serializeArtifact,
  serializeArtifactListItem,
  writeArtifactVersion,
  type SerializedArtifact,
  type SerializedArtifactListItem,
} from "./artifacts.js";
import { linkFileArtifact, readArtifact, readArtifactChunk } from "./tools.js";
import type { ArtifactDb } from "./db.js";
import {
  ARTIFACT_UPLOAD_POLICY,
  createFileArtifact,
  effectiveUploadMime,
  MAX_UPLOAD_BYTES,
  UnsupportedUploadTypeError,
  type UploadPolicy,
} from "./uploads.js";
import type { ContentStore } from "./ports.js";

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

/** Default ceiling on a text artifact's `content`, mirroring `MAX_UPLOAD_BYTES`
 * order of magnitude — generous for any honest artifact body while still
 * catching a caller that pastes an entire tool result verbatim. Hosts that
 * want a different bound pass `maxContentChars`. */
export const DEFAULT_MAX_WORKFLOW_CONTENT_CHARS = 64_000;

/** Who a run authenticates as, and which run it is acting on behalf of. */
export type ResolvedWorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

/**
 * Host-supplied authenticator: given the raw bearer token and the
 * `x-workflow-run-address` header value, resolve which run (if any) is
 * calling. Returning `null` answers 401 — this package makes no assumption
 * about how a host issues or verifies sidecar tokens.
 */
export type WorkflowRunResolver = (
  bearerToken: string,
  runAddress: string,
) => Promise<ResolvedWorkflowRunScope | null> | ResolvedWorkflowRunScope | null;

export type WorkflowArtifactEnv = {
  Variables: { workflowRunScope: ResolvedWorkflowRunScope };
};

/** What a verified agent token proves. Structural, so this package never
 * depends on the library that mints one. */
export type AgentTokenIdentity = {
  readonly tenantId: string;
  readonly definitionId: string;
};

/**
 * Lets a deployed agent authenticate with its own hub-minted bearer instead
 * of the sidecar's token. Only AUTHENTICATION changes: the run is still named
 * by `x-workflow-run-address`, and `resolveRun` is the host's existing lookup
 * for that address. A token whose tenant is not the resolved run's tenant is
 * refused, so a bearer minted for one workbench cannot act on another's run.
 */
export type AgentTokenAuth = {
  /** Verifies the presented `Authorization` header; `undefined` means "not an
   * agent token", and the sidecar path is tried instead. */
  verify: (
    ctx: unknown,
  ) => Promise<AgentTokenIdentity | undefined> | AgentTokenIdentity | undefined;
  resolveRun: (
    runAddress: string,
  ) => Promise<ResolvedWorkflowRunScope | null> | ResolvedWorkflowRunScope | null;
};

export type CreateWorkflowArtifactRoutesDeps = {
  db: ArtifactDb;
  contentStore: ContentStore;
  resolveRunScope: WorkflowRunResolver;
  /** Optional second authentication path, tried before the sidecar token. */
  agentToken?: AgentTokenAuth;
  /** Which files `POST /artifacts/binary` accepts. Defaults to the same
   * policy `createArtifactRoutes`' `POST /artifacts/upload` uses. */
  uploadPolicy?: UploadPolicy;
  /** Byte ceiling for `POST /artifacts/binary`. Defaults to `MAX_UPLOAD_BYTES`
   * — the same per-file ceiling the tenant upload route enforces, so there is
   * one number for "how big a file artifact may be" rather than a second
   * that could drift from it. */
  maxBinaryBytes?: number;
  /** Character ceiling for `POST /artifacts`' `content`. */
  maxContentChars?: number;
};

export type CreatedWorkflowArtifact = { readonly id: string; readonly version: number };

// Opaque to this package, same shape `mount.ts` validates: any JSON object,
// or `null` to clear it explicitly. Mirrors `NullableMetadata` there.
const NullableMetadata = MetadataShape.or("null");

const CreateWorkflowArtifactBody = type({
  title: "string > 0",
  kind: "string > 0",
  content: "string > 0",
  "metadata?": NullableMetadata,
});

const CreateWorkflowBinaryArtifactBody = type({
  filename: "string > 0",
  mimeType: "string > 0",
  contentBase64: "string > 0",
  "metadata?": NullableMetadata,
});

const LinkWorkflowFileBody = type({
  title: "string > 0",
  kind: "string > 0",
  path: "string > 0",
  "preview?": "string",
});

// `metadata` is opaque and, when omitted, carries the prior version's
// metadata forward — same semantics as `ReviseArtifactRequest` in mount.ts —
// so at least one of the three must be present or there is nothing to revise.
const ReviseWorkflowArtifactBody = type({
  "title?": "string > 0",
  "content?": "string",
  "metadata?": NullableMetadata,
}).narrow(
  (body, ctx) =>
    body.title !== undefined ||
    body.content !== undefined ||
    body.metadata !== undefined ||
    ctx.mustBe("a body with content, title, and/or metadata"),
);

/** Omits the key entirely when absent or unparseable, so the behavior's own
 * default applies rather than a coerced zero. */
function parseNumberQuery<K extends string>(
  key: K,
  raw: string | undefined,
): Partial<Record<K, number>> {
  if (raw === undefined || raw === "") return {};
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return {};
  return { [key]: n } as Record<K, number>;
}

function parseVersionQuery(raw: string | undefined): { version?: number } {
  return parseNumberQuery("version", raw);
}

/** A missing artifact or a missing pinned version both read as 404; anything
 * else is the caller's own bad argument. */
function readFailure(c: Context<WorkflowArtifactEnv>, err: unknown): Response {
  if (err instanceof ArtifactNotFoundError) {
    return c.json({ error: "Artifact not found" }, 404);
  }
  if (err instanceof Error) return c.json({ error: err.message }, 400);
  throw err;
}

function parseRecentLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECENT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

/**
 * Build the run-scoped artifact routes as a sub-app the host mounts with
 * `app.route`, at `WORKFLOW_ARTIFACTS_BASE_PATH`. Unlike
 * `createArtifactRoutes`, every route here is behind its own bearer-token
 * middleware — there is no unauthenticated collection-read case, since a
 * workflow run always presents credentials.
 */
export function createWorkflowArtifactRoutes({
  db,
  contentStore,
  resolveRunScope,
  agentToken,
  uploadPolicy = ARTIFACT_UPLOAD_POLICY,
  maxBinaryBytes = MAX_UPLOAD_BYTES,
  maxContentChars = DEFAULT_MAX_WORKFLOW_CONTENT_CHARS,
}: CreateWorkflowArtifactRoutesDeps): Hono<WorkflowArtifactEnv> {
  const app = new Hono<WorkflowArtifactEnv>();

  const authenticate: MiddlewareHandler<WorkflowArtifactEnv> = async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";

    if (agentToken !== undefined) {
      const identity = await agentToken.verify(c);
      if (identity !== undefined) {
        const runScope = await agentToken.resolveRun(address);
        // Same 401 whether the address named no run or named another
        // tenant's: a bearer learns nothing from the difference.
        if (runScope === null || runScope.tenantId !== identity.tenantId) {
          return c.json({ error: "Missing or unrecognized bearer token / run address" }, 401);
        }
        c.set("workflowRunScope", runScope);
        await next();
        return undefined;
      }
    }

    const scope = await resolveRunScope(token, address);
    if (scope === null) {
      return c.json(
        {
          error: "Missing or unrecognized sidecar bearer token / run address",
        },
        401,
      );
    }
    c.set("workflowRunScope", scope);
    await next();
  };
  app.use("*", authenticate);

  app.post("/artifacts", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateWorkflowArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }
    if (parsed.content.length > maxContentChars) {
      return c.json(
        {
          error:
            `content is ${parsed.content.length} characters, over the ` +
            `${maxContentChars}-character limit — shorten it or split it ` +
            "into multiple artifacts and try again.",
        },
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    const row = await db.transaction((tx) =>
      createArtifact(tx, {
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
        // Workflow-authored artifacts have no human owner-member by default;
        // a human only enters the picture as the approver who let the
        // finalize tool call through, not as an owner.
        ownerPrincipalId: null,
        kind: parsed.kind,
        title: parsed.title,
        content: parsed.content,
        source: { origin: "workflow", runId: scope.runId },
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      }),
    );
    const created: CreatedWorkflowArtifact = { id: row.id, version: row.version };
    return c.json({ data: created }, 201);
  });

  app.get("/artifacts/recent", async (c) => {
    const scope = c.get("workflowRunScope");
    const limit = parseRecentLimit(c.req.query("limit"));
    const page = await listArtifacts(db, scope.tenantId, { limit });
    const data: readonly SerializedArtifactListItem[] = page.rows.map(
      serializeArtifactListItem,
    );
    return c.json({ data });
  });

  app.post("/artifacts/binary", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = CreateWorkflowBinaryArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }

    const bytes = Buffer.from(parsed.contentBase64, "base64");
    if (bytes.byteLength > maxBinaryBytes) {
      return c.json(
        {
          error:
            `content is ${bytes.byteLength} bytes, over the ` +
            `${maxBinaryBytes}-byte limit — shorten it or split it into ` +
            "multiple artifacts and try again.",
        },
        413,
      );
    }

    const scope = c.get("workflowRunScope");
    const artifactScope = { tenantId: scope.tenantId, principalId: scope.principalId };
    try {
      const row = await db.transaction((tx) =>
        createFileArtifact(tx, contentStore, {
          scope: artifactScope,
          ownerPrincipalId: null,
          filename: parsed.filename,
          mimeType: effectiveUploadMime(
            { name: parsed.filename, type: parsed.mimeType },
            uploadPolicy,
          ),
          bytes: new Uint8Array(bytes),
          policy: uploadPolicy,
          generatedBy: scope.runId,
          ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
        }),
      );
      const created: CreatedWorkflowArtifact = { id: row.id, version: row.version };
      return c.json({ data: created }, 201);
    } catch (err) {
      if (err instanceof UnsupportedUploadTypeError) {
        return c.json({ error: err.message }, 415);
      }
      throw err;
    }
  });

  // The remaining routes complete the surface `ARTIFACT_TOOL_DEFINITIONS`
  // describes, so a run-scoped caller can do everything a tool names.
  app.get("/artifacts", async (c) => {
    const scope = c.get("workflowRunScope");
    const kind = c.req.query("kind");
    const page = await listArtifacts(db, scope.tenantId, {
      limit: parseRecentLimit(c.req.query("limit")),
      ...(kind !== undefined && kind !== "" ? { kind } : {}),
    });
    const data: readonly SerializedArtifactListItem[] = page.rows.map(serializeArtifactListItem);
    return c.json({ data });
  });

  app.get("/artifacts/find", async (c) => {
    const scope = c.get("workflowRunScope");
    const title = c.req.query("title") ?? "";
    if (title === "") return c.json({ error: "title is required" }, 400);
    const kind = c.req.query("kind");
    const found = await findArtifactByTitle(
      db,
      scope.tenantId,
      title,
      kind === "" ? undefined : kind,
    );
    return c.json({ data: found });
  });

  app.post("/artifacts/link-file", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = LinkWorkflowFileBody(body);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }
    const scope = c.get("workflowRunScope");
    const row = await linkFileArtifact(db, {
      scope: { tenantId: scope.tenantId, principalId: scope.principalId },
      ownerPrincipalId: null,
      title: parsed.title,
      kind: parsed.kind,
      path: parsed.path,
      ...(parsed.preview !== undefined ? { preview: parsed.preview } : {}),
      sessionId: scope.runId,
    });
    const created: CreatedWorkflowArtifact = { id: row.id, version: row.version };
    return c.json({ data: created }, 201);
  });

  app.patch("/artifacts/:id", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = ReviseWorkflowArtifactBody(body);
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }
    if (parsed.content !== undefined && parsed.content.length > maxContentChars) {
      return c.json(
        {
          error:
            `content is ${parsed.content.length} characters, over the ` +
            `${maxContentChars}-character limit — shorten it or split it ` +
            "into multiple artifacts and try again.",
        },
        413,
      );
    }
    const scope = c.get("workflowRunScope");
    const artifactId = c.req.param("id");
    const existing = await getArtifact(db, artifactId);
    if (existing === null || existing.tenantId !== scope.tenantId) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const written = await writeArtifactVersion(db, {
      scope: { tenantId: scope.tenantId, principalId: scope.principalId },
      artifactId,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.content !== undefined ? { content: parsed.content } : {}),
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    });
    const revised: CreatedWorkflowArtifact = {
      id: written.artifactId,
      version: written.version,
    };
    return c.json({ data: revised });
  });

  app.get("/artifacts/:id/read", async (c) => {
    const scope = c.get("workflowRunScope");
    try {
      const data = await readArtifact(db, {
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
        artifactId: c.req.param("id"),
        ...parseVersionQuery(c.req.query("version")),
      });
      return c.json({ data });
    } catch (err) {
      return readFailure(c, err);
    }
  });

  app.get("/artifacts/:id/chunk", async (c) => {
    const scope = c.get("workflowRunScope");
    try {
      const data = await readArtifactChunk(db, {
        scope: { tenantId: scope.tenantId, principalId: scope.principalId },
        artifactId: c.req.param("id"),
        ...parseVersionQuery(c.req.query("version")),
        ...parseNumberQuery("offset", c.req.query("offset")),
        ...parseNumberQuery("limit", c.req.query("limit")),
      });
      return c.json({ data });
    } catch (err) {
      return readFailure(c, err);
    }
  });

  app.get("/artifacts/:id", async (c) => {
    const scope = c.get("workflowRunScope");
    const artifactId = c.req.param("id");
    const row = await getArtifact(db, artifactId);
    // Fetch-then-check, exactly mirroring the tenant routes' single-artifact
    // handlers: an id from another tenant reads back
    // identically to an id that never existed — never a distinguishable 403.
    if (row === null || row.tenantId !== scope.tenantId) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const artifact: SerializedArtifact = serializeArtifact(row);
    return c.json({ data: artifact });
  });

  return app;
}
