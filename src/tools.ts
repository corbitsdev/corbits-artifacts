import { and, eq } from "drizzle-orm";
import type { ArtifactDb } from "./db.js";
import {
  ArtifactNotFoundError,
  createArtifact,
  getArtifactVersion,
  SKILL_DRAFT_KIND,
} from "./artifacts.js";
import { artifact, type ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal, Identity } from "./ports.js";
import {
  parseWebSiteContentJson,
  normalizeWebSitePath,
  summarizeWebSiteContent,
  WEB_SITE_KIND,
  type WebSiteReadSummary,
} from "./web-site.js";

/**
 * An agent runtime caps a tool result at ~10K characters and spills the rest to
 * a URI the model cannot read. A chunk is measured in raw characters, but the
 * result is JSON-encoded before that cap applies and escaping inflates it — so
 * the ENCODED result, not the raw slice, must stay under this budget.
 */
export const SAFE_ENCODED_BUDGET = 9000;
export const DEFAULT_READ_LIMIT = 8000;

export type ArtifactReadResult = {
  artifactId: string;
  title: string;
  kind: string;
  version: number;
  content: string;
  contentLength?: number;
  chunkStart?: number;
  chunkEnd?: number;
  continuation?: string;
  path?: string;
};

const encodedLength = (value: unknown) => JSON.stringify(value, null, 2).length;

type ReadBase = Omit<ArtifactReadResult, "content">;

function chunk(
  base: ReadBase,
  content: string,
  start: number,
  end: number,
  total: number,
): ArtifactReadResult {
  return {
    ...base,
    content: content.slice(start, end),
    contentLength: total,
    chunkStart: start,
    chunkEnd: end,
    ...(end < total
      ? {
          continuation: `Showing characters ${start}–${end} of ${total}. Call artifact_read_chunk again with offset=${end} (same artifactId) to read the next chunk, and keep going until there is no continuation field.`,
        }
      : {}),
  };
}

/**
 * Return as much content as fits the encoded budget. Whole content when it is
 * small enough and no window was asked for; otherwise a chunk shrunk (by the
 * measured overshoot ratio, so it converges fast) until it encodes small enough.
 */
export function windowContent(
  base: ReadBase,
  content: string,
  offset?: number,
  limit?: number,
): ArtifactReadResult {
  const total = content.length;
  if (offset === undefined && limit === undefined && total <= DEFAULT_READ_LIMIT) {
    const whole = { ...base, content };
    if (encodedLength(whole) <= SAFE_ENCODED_BUDGET) return whole;
  }

  // Clamp both to non-negative: these arrive model-supplied, and a negative
  // offset would silently read from the END of the content via slice().
  const start = Math.min(Math.max(0, offset ?? 0), total);
  let end = Math.min(start + Math.max(0, limit ?? DEFAULT_READ_LIMIT), total);
  let result = chunk(base, content, start, end, total);
  while (end > start + 1 && encodedLength(result) > SAFE_ENCODED_BUDGET) {
    const shrunk =
      start +
      Math.max(
        1,
        Math.floor((end - start) * (SAFE_ENCODED_BUDGET / encodedLength(result))),
      );
    end = shrunk >= end ? end - 1 : shrunk;
    result = chunk(base, content, start, end, total);
  }
  return result;
}

/**
 * Resolve an artifact for an agent read, honoring a version pin and an explicit
 * cross-tenant target. skill-draft reads as NOT FOUND, not forbidden.
 */
async function resolveForRead(
  db: ArtifactDb,
  identity: Identity,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    version?: number;
    tenantId?: string;
  },
): Promise<{ base: ReadBase; content: string }> {
  const tenantId = args.tenantId ?? args.scope.tenantId;
  if (
    tenantId !== args.scope.tenantId &&
    !(await identity.ownerIsMemberOfTenant(args.scope, tenantId))
  ) {
    throw new ArtifactNotFoundError(args.artifactId);
  }

  const [row] = await db
    .select()
    .from(artifact)
    .where(and(eq(artifact.id, args.artifactId), eq(artifact.tenantId, tenantId)))
    .limit(1);
  if (!row || row.kind === SKILL_DRAFT_KIND) {
    throw new ArtifactNotFoundError(args.artifactId);
  }

  if (args.version === undefined) {
    return {
      base: {
        artifactId: row.id,
        title: row.title,
        kind: row.kind,
        version: row.version,
      },
      content: row.content,
    };
  }

  const pinned = await getArtifactVersion(db, args.artifactId, args.version);
  if (!pinned) {
    throw new Error(
      `Version ${args.version} not found for artifact ${args.artifactId}`,
    );
  }
  return {
    base: {
      artifactId: row.id,
      title: pinned.title,
      kind: row.kind,
      version: pinned.version,
    },
    content: pinned.content,
  };
}

/**
 * `artifact_read`: whole (budgeted) content, or — for `web_site` — a structural
 * summary, or one file's content when `path` is given. Reading the raw JSON
 * bundle of a site is never useful to a model and always blows the budget.
 */
export async function readArtifact(
  db: ArtifactDb,
  identity: Identity,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    version?: number;
    tenantId?: string;
    path?: string;
  },
): Promise<ArtifactReadResult | (ReadBase & { summary: WebSiteReadSummary })> {
  const { base, content } = await resolveForRead(db, identity, args);
  if (base.kind !== WEB_SITE_KIND) return windowContent(base, content);

  if (args.path === undefined) {
    return { ...base, summary: summarizeWebSiteContent(content) };
  }
  const path = normalizeWebSitePath(args.path);
  const file = parseWebSiteContentJson(content).files[path];
  if (file === undefined) {
    throw new Error(`File not found in web_site artifact: ${path}`);
  }
  return { ...windowContent(base, file), path };
}

/** `artifact_read_chunk`: one bounded character range. Not for `web_site`. */
export async function readArtifactChunk(
  db: ArtifactDb,
  identity: Identity,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    version?: number;
    tenantId?: string;
    offset?: number;
    limit?: number;
  },
): Promise<ArtifactReadResult> {
  const { base, content } = await resolveForRead(db, identity, args);
  if (base.kind === WEB_SITE_KIND) {
    throw new Error(
      "artifact_read_chunk does not support web_site artifacts; use artifact_read for a summary or pass path to read one file",
    );
  }
  return windowContent(
    base,
    content,
    args.offset ?? 0,
    args.limit ?? DEFAULT_READ_LIMIT,
  );
}

/**
 * `artifact_link_file`: the write behavior behind the descriptor of the same
 * name. An agent has just written a file into its own workspace; this mints the
 * artifact that points at it, so the file shows up in the gallery next to every
 * other artifact instead of staying invisible inside the run.
 *
 * NO BYTES MOVE HERE, and that is the whole distinction from
 * `createFileArtifact`. The agent workspace is the host's filesystem, not this
 * module's — the module has no way to read `path` and must not pretend to. The
 * artifact records WHERE the file is (`source.workspace.path`) and carries the
 * agent's own short preview as its content, which is what a gallery row and a
 * subsequent `artifact_read` need. A host that wants the bytes ingested reads
 * the file itself and calls `createFileArtifact` instead.
 *
 * Like every other create path: the artifact and its version 1 land in one
 * transaction, `web_site` content is normalized, and skill-draft is refused by
 * `createArtifact`.
 */
export async function linkFileArtifact(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    ownerPrincipalId: string | null;
    title: string;
    kind: string;
    /** Where the file lives in the agent workspace, relative to its root. */
    path: string;
    /** Short preview the agent supplies; becomes the artifact's content. */
    preview?: string;
    sessionId?: string;
  },
): Promise<ArtifactRow> {
  const path = args.path.trim();
  if (path.length === 0) {
    throw new Error("artifact_link_file requires a workspace path");
  }
  return await db.transaction((tx) =>
    createArtifact(tx, {
      scope: args.scope,
      ownerPrincipalId: args.ownerPrincipalId,
      kind: args.kind,
      title: args.title,
      content: args.preview ?? "",
      source: {
        origin: "agent",
        workspace: { path },
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      },
    }),
  );
}

/**
 * Tool descriptors for hosts that register these behaviors with an agent
 * runtime. Structural, not imported from a runtime package: this module stays
 * free of any agent-SDK dependency, and the host binds each name to the
 * exported behavior above with its own session context.
 */
export type ArtifactToolDefinition = {
  name: string;
  sideEffect: "read" | "write";
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
};

export const ARTIFACT_TOOL_DEFINITIONS: readonly ArtifactToolDefinition[] = [
  {
    name: "artifact_create",
    sideEffect: "write",
    description:
      "Create a new artifact with inline content. Returns the artifact id and version. Revise it later with artifact_write.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Artifact title." },
        kind: {
          type: "string",
          description:
            "Artifact kind, such as document, email, memo, note, or web_site for a multi-file static site stored as JSON { entry?, files: { path: content } }.",
        },
        content: { type: "string", description: "The full text content." },
      },
      required: ["title", "kind", "content"],
    },
  },
  {
    name: "artifact_link_file",
    sideEffect: "write",
    description:
      "Create an artifact row linked to a file in the agent workspace. Call this after writing the file.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Artifact title." },
        kind: { type: "string", description: "Artifact kind." },
        path: {
          type: "string",
          description: "Relative path to the file in the agent workspace.",
        },
        preview: {
          type: "string",
          description: "Optional short preview shown before the file is opened.",
        },
      },
      required: ["title", "kind", "path"],
    },
  },
  {
    name: "artifact_read",
    sideEffect: "read",
    description:
      "Read an artifact by id. Returns its title, kind, current version, and content. Pass version to read a past version. When the content is too large, the result carries a 'continuation' field telling you to read on with artifact_read_chunk.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact id to read." },
        version: {
          type: "number",
          description: "Optional version to read. Defaults to the latest.",
        },
        tenantId: {
          type: "string",
          description:
            "Optional tenant the artifact lives in. Defaults to your own tenant.",
        },
        path: {
          type: "string",
          description:
            "For kind=web_site only: return one file's content at this relative path. Without path, web_site reads return a summary.",
        },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "artifact_read_chunk",
    sideEffect: "read",
    description:
      "Read one bounded chunk of an artifact's content by character range. Pass the offset named in the prior result's 'continuation' field, and keep going until a result has no 'continuation'. Not supported for kind=web_site.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact id to read." },
        offset: {
          type: "number",
          description: "Zero-based character offset to start from. Defaults to 0.",
        },
        limit: {
          type: "number",
          description: "Maximum characters to return in this call.",
        },
        version: {
          type: "number",
          description: "Optional version to read. Defaults to the latest.",
        },
        tenantId: {
          type: "string",
          description: "Optional tenant the artifact lives in.",
        },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "artifact_write",
    sideEffect: "write",
    description:
      "Revise an existing artifact, creating a new version. Provide content and/or title.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact id to revise." },
        title: { type: "string", description: "New title." },
        content: { type: "string", description: "New full content." },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "artifact_list",
    sideEffect: "read",
    description:
      "List artifacts in your tenant, most recently updated first. Archived artifacts are never listed.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Optional kind filter." },
        limit: { type: "number", description: "Maximum artifacts to return." },
      },
      required: [],
    },
  },
  {
    name: "artifact_find_by_title",
    sideEffect: "read",
    description:
      "Find the most recently updated non-archived artifact with an exact title. Returns null when there is none.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The exact artifact title." },
        kind: { type: "string", description: "Optional kind filter." },
      },
      required: ["title"],
    },
  },
];
