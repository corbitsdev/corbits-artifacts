import { and, eq } from "drizzle-orm";
import type { ArtifactDb } from "./db.js";
import {
  ArtifactNotFoundError,
  createArtifact,
  getArtifactVersion,
} from "./artifacts.js";
import { artifact, type ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal } from "./ports.js";

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
          continuation: `Showing characters ${start}–${end} of ${total}. Call artifact_read again with offset=${end} (same artifactId) to read the next chunk, and keep going until there is no continuation field.`,
        }
      : {}),
  };
}

/**
 * Return as much content as fits the encoded budget. Whole content when it is
 * small enough and no window was asked for; otherwise a chunk shrunk (by the
 * measured overshoot ratio, so it converges fast) until it encodes small enough.
 */
function windowContent(
  base: ReadBase,
  content: string,
  offset?: number,
  limit?: number,
): ArtifactReadResult {
  const total = content.length;
  if (
    offset === undefined &&
    limit === undefined &&
    total <= DEFAULT_READ_LIMIT
  ) {
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
        Math.floor(
          (end - start) * (SAFE_ENCODED_BUDGET / encodedLength(result)),
        ),
      );
    end = shrunk >= end ? end - 1 : shrunk;
    result = chunk(base, content, start, end, total);
  }
  return result;
}

/**
 * Resolve an artifact for an agent read, honoring a version pin. Reads are
 * always confined to the caller's tenant; there is no tenant override.
 */
async function resolveForRead(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    version?: number;
  },
): Promise<{ base: ReadBase; content: string }> {
  const [row] = await db
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.id, args.artifactId),
        eq(artifact.tenantId, args.scope.tenantId),
      ),
    )
    .limit(1);
  if (!row) {
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
    throw new ArtifactNotFoundError(args.artifactId);
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
 * `artifact_read`: the whole (budgeted) content, or one character range when
 * `offset` or `limit` is given.
 */
export async function readArtifact(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    version?: number;
    offset?: number;
    limit?: number;
  },
): Promise<ArtifactReadResult> {
  const { base, content } = await resolveForRead(db, args);
  return windowContent(base, content, args.offset, args.limit);
}

/**
 * `artifact_write` given a workspace `path` instead of content. An agent has just written a file into its own workspace; this mints the
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
 * transaction through `createArtifact`.
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
    throw new Error("linking a file requires a workspace path");
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
    properties: Record<
      string,
      { type: string; description: string; items?: Record<string, unknown> }
    >;
    required: string[];
  };
};

const VERSION_PROPERTY = {
  type: "number",
  description: "Optional version to read. Defaults to the latest.",
};

export const ARTIFACT_TOOL_DEFINITIONS: readonly ArtifactToolDefinition[] = [
  {
    name: "artifact_write",
    sideEffect: "write",
    description:
      "Create or revise an artifact. Every call returns the artifact id and its new version; pass that version as expectedVersion on your next revision. Create: omit artifactId and pass title, kind, and content (or path, for a file you already wrote in your workspace). Revise: pass artifactId with edits to change exact passages, or content to replace the whole text. Prefer edits for small changes. If an edit is refused, nothing was written: read the artifact again and retry.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          description: "The artifact to revise. Omit to create one.",
        },
        title: {
          type: "string",
          description: "Title. Required when creating.",
        },
        kind: {
          type: "string",
          description:
            "Kind, such as document, email, memo, or note. Required when creating.",
        },
        content: {
          type: "string",
          description:
            "The full text. Mutually exclusive with path, and not allowed together with edits.",
        },
        edits: {
          type: "array",
          description:
            "Revisions only: [{ oldText, newText }], applied in order. oldText is copied exactly from the current text and must appear there once; add surrounding words until it does. newText replaces it; an empty newText deletes it. To insert, use a nearby passage as oldText and repeat it in newText with the addition.",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
          },
        },
        expectedVersion: {
          type: "number",
          description:
            "Revisions only: the version you last read. The write is refused if the artifact has moved past it.",
        },
        path: {
          type: "string",
          description:
            "Creating only: a file in your workspace to link instead of passing content.",
        },
        preview: {
          type: "string",
          description:
            "With path: a short preview shown before the file is opened.",
        },
        metadata: {
          type: "object",
          description:
            "Optional application metadata stored with the version, e.g. which project and stage this belongs to.",
        },
      },
      required: [],
    },
  },
  {
    name: "artifact_read",
    sideEffect: "read",
    description:
      "Read an artifact by id: its title, kind, version, and content. Pass version for a past version. Long content comes back in ranges; when the result has a 'continuation' field, call again with the offset it names.",
    inputSchema: {
      type: "object",
      properties: {
        artifactId: { type: "string", description: "The artifact id to read." },
        version: VERSION_PROPERTY,
        offset: {
          type: "number",
          description:
            "Zero-based character offset to start from. An offset at or past the end of the content returns empty content; read with offset 0 to tell that apart. Limit returns as much as fits before a continuation.",
        },
        limit: {
          type: "number",
          description: "Maximum characters to return.",
        },
      },
      required: ["artifactId"],
    },
  },
  {
    name: "artifact_search",
    sideEffect: "read",
    description:
      "Find artifacts in your tenant, most recently updated first. Returns each match's id, title, kind, and version, not its content; read one with artifact_read. When there are more matches than fit on the page, the result also carries a nextCursor — pass it back as cursor on your next artifact_search (keeping the same query and kind) to continue paging until no cursor is returned. With no query it lists the newest. Archived artifacts are never returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Text to match — a case-insensitive substring (ILIKE) match on the title or content, not an exact-title lookup.",
        },
        kind: { type: "string", description: "Optional kind filter." },
        limit: { type: "number", description: "Maximum artifacts to return." },
        cursor: {
          type: "string",
          description:
            "Pass the nextCursor of the previous artifact_search call to page to the next results.",
        },
      },
      required: [],
    },
  },
];
