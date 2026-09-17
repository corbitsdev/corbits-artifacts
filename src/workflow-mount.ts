/**
 * Run-scoped variant of `mountArtifacts` for a host whose workflow-run
 * callers have no browser session and thus no `TenantEnv`/`principal` on the
 * context — a sidecar bearer token + run address instead. `mountArtifacts`
 * itself has no bearer-token auth surface at all and never will: mixing two
 * unrelated auth conventions into one mount would make each harder to reason
 * about, so this is a second, parallel mount a host wires up only when it
 * actually runs workflows.
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
import type { Hono, MiddlewareHandler } from "hono";
import {
  createArtifact,
  getArtifact,
  listArtifacts,
  serializeArtifact,
  serializeArtifactListItem,
  SKILL_DRAFT_KIND,
  type SerializedArtifact,
  type SerializedArtifactListItem,
} from "./artifacts.js";
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

export type MountWorkflowArtifactsOpts = {
  db: ArtifactDb;
  contentStore: ContentStore;
  resolveRunScope: WorkflowRunResolver;
  /** Which files `POST /artifacts/binary` accepts. Defaults to the same
   * policy `mountArtifacts`' `POST /artifacts/upload` uses. */
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

const CreateWorkflowArtifactBody = type({
  title: "string > 0",
  kind: "string > 0",
  content: "string > 0",
});

const CreateWorkflowBinaryArtifactBody = type({
  filename: "string > 0",
  mimeType: "string > 0",
  contentBase64: "string > 0",
});

function parseRecentLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_RECENT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

/**
 * Mount the run-scoped artifact routes onto a host Hono app. Unlike
 * `mountArtifacts`, every route here is behind its own bearer-token
 * middleware — there is no unauthenticated collection-read case, since a
 * workflow run always presents credentials.
 */
export function mountWorkflowArtifacts(
  app: Hono<WorkflowArtifactEnv>,
  opts: MountWorkflowArtifactsOpts,
): Hono<WorkflowArtifactEnv> {
  const {
    db,
    contentStore,
    resolveRunScope,
    uploadPolicy = ARTIFACT_UPLOAD_POLICY,
    maxBinaryBytes = MAX_UPLOAD_BYTES,
    maxContentChars = DEFAULT_MAX_WORKFLOW_CONTENT_CHARS,
  } = opts;

  const authenticate: MiddlewareHandler<WorkflowArtifactEnv> = async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
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

  app.get("/artifacts/:id", async (c) => {
    const scope = c.get("workflowRunScope");
    const artifactId = c.req.param("id");
    const row = await getArtifact(db, artifactId);
    // Fetch-then-check, exactly mirroring `mountArtifacts`' own single-artifact
    // routes: an id from another tenant, or a skill-draft, reads back
    // identically to an id that never existed — never a distinguishable 403.
    if (row === null || row.tenantId !== scope.tenantId || row.kind === SKILL_DRAFT_KIND) {
      return c.json({ error: "Artifact not found" }, 404);
    }
    const artifact: SerializedArtifact = serializeArtifact(row);
    return c.json({ data: artifact });
  });

  return app;
}
