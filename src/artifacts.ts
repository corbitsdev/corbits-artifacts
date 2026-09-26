import "./arktype.js";
import { createHash } from "node:crypto";
import { type } from "arktype";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { ArtifactDb, ArtifactTx } from "./db.js";
import { artifact, artifactVersion, type ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal } from "./ports.js";

/**
 * Max title length (JavaScript string length) accepted on create/revise.
 * Keep in sync with mount OpenAPI and package README.
 */
export const MAX_ARTIFACT_TITLE_LENGTH = 512;

/**
 * Max body size in UTF-8 bytes on create/revise. Sized above MAX_UPLOAD_BYTES
 * so base64 data-URL expansion for file artifacts still fits.
 */
export const MAX_ARTIFACT_CONTENT_BYTES = 15 * 1024 * 1024;

export class ArtifactSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSizeError";
  }
}

/** Reject oversize title/content before they hit the database. */
export function assertArtifactFieldSizes(fields: {
  title?: string;
  content?: string;
}): void {
  if (
    fields.title !== undefined &&
    fields.title.length > MAX_ARTIFACT_TITLE_LENGTH
  ) {
    throw new ArtifactSizeError(
      `Artifact title exceeds the ${MAX_ARTIFACT_TITLE_LENGTH} character limit`,
    );
  }
  if (fields.content !== undefined) {
    const bytes = Buffer.byteLength(fields.content, "utf8");
    if (bytes > MAX_ARTIFACT_CONTENT_BYTES) {
      throw new ArtifactSizeError(
        `Artifact content exceeds the ${MAX_ARTIFACT_CONTENT_BYTES} byte limit`,
      );
    }
  }
}

/** Coarse producer classes. `unknown` covers rows written before provenance. */
export const ARTIFACT_ORIGINS = [
  "workflow",
  "agent",
  "manual",
  "imported",
  "unknown",
] as const;
const KnownOriginSource = type({
  origin: type.enumerated(...ARTIFACT_ORIGINS),
});
// A jsonb value that is an object — not null, not an array, not a scalar.
const JsonObject = type("object").narrow(
  (value): value is Record<string, unknown> => !Array.isArray(value),
);

// `metadata` is opaque to the package: any JSON object is accepted and
// returned as-is, never interpreted. `parentVersionIds` is explicit lineage —
// a plain array of ids, never inferred from version order.
// Exported so the HTTP mount validates request bodies the same opaque way.
export const MetadataShape = JsonObject;
const ParentVersionIdsShape = type("string[]");

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

/** Reject a malformed `metadata` or `parentVersionIds` before they hit the database. */
export function assertVersionMetadataShape(fields: {
  metadata?: unknown;
  parentVersionIds?: unknown;
}): void {
  if (fields.metadata !== undefined && fields.metadata !== null) {
    const result = MetadataShape(fields.metadata);
    if (result instanceof type.errors) {
      throw new ArtifactValidationError(`Invalid metadata: ${result.summary}`);
    }
  }
  if (
    fields.parentVersionIds !== undefined &&
    fields.parentVersionIds !== null
  ) {
    const result = ParentVersionIdsShape(fields.parentVersionIds);
    if (result instanceof type.errors) {
      throw new ArtifactValidationError(
        `Invalid parentVersionIds: ${result.summary}`,
      );
    }
  }
}

/**
 * A null source, one that is not a JSON object at all, or one with an
 * unrecognized origin, all read as `unknown`.
 *
 * The parameter is `unknown` because the column is plain `jsonb` with no
 * `$type` annotation (Interchange never annotates one, and the annotation was
 * a claim Postgres does not enforce — a `jsonb` column holds `3`, `"x"` and
 * `[]` just as happily as an object).
 */
export function normalizeSource(
  raw: unknown,
): Record<string, unknown> & { origin: string } {
  const known = KnownOriginSource(raw);
  if (!(known instanceof type.errors)) {
    return known as Record<string, unknown> & { origin: string };
  }
  const object = JsonObject(raw);
  if (object instanceof type.errors) return { origin: "unknown" };
  return { ...object, origin: "unknown" };
}

/** Shared JSON fields on every artifact surface (list and detail). */
export type SerializedArtifactBase = {
  id: string;
  kind: string;
  title: string;
  source: Record<string, unknown> & { origin: string };
  version: number;
  ownerPrincipalId: string | null;
  /** Mirrors the current version's `artifact_version.metadata`, opaque to the package. */
  metadata: Record<string, unknown> | null;
  /**
   * sha256 (hex) of the current version's content. Null on a row written
   * before digests existed — never backfilled.
   */
  contentSha256: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Detail / create / revise response — includes the full body. */
export type SerializedArtifact = SerializedArtifactBase & {
  content: string;
};

/**
 * List response item — discovery only. Full `content` is never projected on
 * list; clients fetch a body via detail, download, or tools.
 */
export type SerializedArtifactListItem = SerializedArtifactBase;

/** Row shape returned by `listArtifacts` (no `content` column selected). */
export type ArtifactListRow = Omit<ArtifactRow, "content">;

function serializeArtifactBase(
  row: ArtifactListRow | ArtifactRow,
): SerializedArtifactBase {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    source: normalizeSource(row.source),
    version: row.version,
    ownerPrincipalId: row.ownerPrincipalId,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    contentSha256: row.contentSha256,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeArtifact(row: ArtifactRow): SerializedArtifact {
  return {
    ...serializeArtifactBase(row),
    content: row.content,
  };
}

/** List serializer: same metadata as detail, never the body. */
export function serializeArtifactListItem(
  row: ArtifactListRow,
): SerializedArtifactListItem {
  return serializeArtifactBase(row);
}

/**
 * sha256 (hex) over the UTF-8 bytes of `content`. Used for every text/URL
 * artifact write; a blob-backed file artifact's first version instead passes
 * an explicit digest of the uploaded bytes (see `createFileArtifact` in
 * `uploads.ts`), since its `content` column is a store-specific pointer, not
 * the bytes themselves.
 */
export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type CreateArtifactArgs = {
  scope: ResolvedPrincipal;
  /** The human who owns this artifact; null for agents with no owning member. */
  ownerPrincipalId: string | null;
  kind: string;
  title: string;
  content: string;
  source: Record<string, unknown>;
  /** Opaque to the package; stored and returned as-is on every version read. */
  metadata?: Record<string, unknown> | null;
  /** Explicit lineage for version 1 — never inferred from order. */
  parentVersionIds?: string[] | null;
  /**
   * Digest override for a blob-backed file artifact, whose `content` column
   * is a store-specific pointer rather than the bytes themselves — the caller
   * (`createFileArtifact` in `uploads.ts`) digests the uploaded bytes and
   * passes the result here. Omitted for every other kind, which digests
   * `content` itself.
   */
  contentSha256?: string;
};

/**
 * Create an artifact AND its version 1 in one transaction. Version 1 is
 * eager, never lazy: a pinned read of version 1 must resolve for every
 * artifact, including one that is never revised.
 *
 * Deliberately does no by-title lookup, so it never dedupes against an
 * existing artifact of the same `(tenantId, kind, title)` — correct for its
 * three current callers, which each mean "make a new one" regardless of what
 * already has this title: the `POST /artifacts` route (`mount.ts`), the
 * `artifact_link_file` tool (`linkFileArtifact` in `tools.ts`), and file
 * uploads (`createFileArtifact` in `uploads.ts`). A caller that instead wants
 * "find by title, or create if absent" — converging on one artifact instead
 * of letting duplicates pile up — should use {@link findOrVersionArtifact}.
 */
export async function createArtifact(
  tx: ArtifactTx,
  args: CreateArtifactArgs,
): Promise<ArtifactRow> {
  assertArtifactFieldSizes({ title: args.title, content: args.content });
  assertVersionMetadataShape({
    metadata: args.metadata,
    parentVersionIds: args.parentVersionIds,
  });
  const metadata = args.metadata ?? null;
  const parentVersionIds = args.parentVersionIds ?? null;
  const contentSha256 = args.contentSha256 ?? sha256Hex(args.content);
  const now = new Date();

  const [row] = await tx
    .insert(artifact)
    .values({
      tenantId: args.scope.tenantId,
      principalId: args.scope.principalId,
      ownerPrincipalId: args.ownerPrincipalId,
      kind: args.kind,
      title: args.title,
      content: args.content,
      source: args.source,
      version: 1,
      metadata,
      contentSha256,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Failed to create artifact");

  await tx.insert(artifactVersion).values({
    artifactId: row.id,
    version: 1,
    title: args.title,
    content: args.content,
    source: args.source,
    authorId: args.scope.principalId,
    metadata,
    parentVersionIds,
    contentSha256,
    createdAt: now,
  });

  return row;
}

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`Artifact not found: ${artifactId}`);
    this.name = "ArtifactNotFoundError";
  }
}

/**
 * Thrown by `reviseArtifactVersion` when the caller's `expectedVersion`
 * precondition does not match the current version, observed under the same
 * `FOR UPDATE` lock that guards the write. Nothing is written.
 */
export class VersionConflictError extends Error {
  constructor(
    artifactId: string,
    readonly currentVersion: number,
  ) {
    super(
      `Version conflict on artifact ${artifactId}: current version is ${currentVersion}`,
    );
    this.name = "VersionConflictError";
  }
}

/**
 * The lock-and-write core of a revision, sharing a caller-supplied `tx` so it
 * composes with a lock already held on that transaction (see
 * `findOrVersionArtifact`) instead of opening a second one. The artifact row
 * is locked `FOR UPDATE` so concurrent writers on the same id serialize
 * instead of both computing the same next version; the (artifactId, version)
 * unique index is the second half of that guard.
 *
 * Archived artifacts present as NOT FOUND — an agent holding a
 * stale id must not silently revise something the user put away.
 */
export async function reviseArtifactVersion(
  tx: ArtifactTx,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    title?: string;
    content?: string;
    /** Opaque to the package; undefined carries the prior version's metadata forward. */
    metadata?: Record<string, unknown> | null;
    /** Explicit lineage for this version — never inferred, never carried forward. */
    parentVersionIds?: string[] | null;
    /**
     * Stores new file content once the row is locked and `expectedVersion`
     * holds, so a refused revise never writes bytes. Omitted carries the
     * prior `source` and digest forward.
     */
    storeFile?: (locked: ArtifactRow) => Promise<{
      content: string;
      source: Record<string, unknown>;
      contentSha256: string;
    }>;
    /**
     * Precondition checked under the `FOR UPDATE` lock below: when set and it
     * does not match the current version, {@link VersionConflictError} is
     * thrown and nothing is written. Omitted preserves today's behavior.
     */
    expectedVersion?: number;
  },
  now: Date,
): Promise<ArtifactRow> {
  assertVersionMetadataShape({
    metadata: args.metadata,
    parentVersionIds: args.parentVersionIds,
  });
  const [existing] = await tx
    .select()
    .from(artifact)
    .where(
      and(
        eq(artifact.id, args.artifactId),
        eq(artifact.tenantId, args.scope.tenantId),
      ),
    )
    .for("update")
    .limit(1);

  if (!existing || existing.archivedAt !== null) {
    throw new ArtifactNotFoundError(args.artifactId);
  }

  if (
    args.expectedVersion !== undefined &&
    args.expectedVersion !== existing.version
  ) {
    throw new VersionConflictError(args.artifactId, existing.version);
  }

  const file = args.storeFile ? await args.storeFile(existing) : undefined;
  const version = existing.version + 1;
  const title = args.title ?? existing.title;
  const content = file?.content ?? args.content ?? existing.content;
  if (args.content !== undefined) {
    assertArtifactFieldSizes({ content });
  }
  const metadata =
    args.metadata === undefined
      ? (existing.metadata as Record<string, unknown> | null)
      : args.metadata;
  const parentVersionIds = args.parentVersionIds ?? null;
  const source = file?.source ?? existing.source;
  // Content omitted: the previous content carries forward, so its digest
  // carries forward unchanged rather than being recomputed.
  const contentSha256 =
    file?.contentSha256 ??
    (args.content === undefined ? existing.contentSha256 : sha256Hex(content));

  const [updated] = await tx
    .update(artifact)
    .set({
      title,
      content,
      source,
      version,
      metadata,
      contentSha256,
      updatedAt: now,
    })
    .where(eq(artifact.id, args.artifactId))
    .returning();
  if (!updated) throw new ArtifactNotFoundError(args.artifactId);

  await tx.insert(artifactVersion).values({
    artifactId: args.artifactId,
    version,
    title,
    content,
    source,
    authorId: args.scope.principalId,
    metadata,
    parentVersionIds,
    contentSha256,
    createdAt: now,
  });

  return updated;
}

/**
 * Revise an artifact: bump `version`, append a history row. See
 * {@link reviseArtifactVersion} for the locking behavior.
 */
export async function writeArtifactVersion(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    title?: string;
    content?: string;
    /** Opaque to the package; omit to carry the prior version's metadata forward. */
    metadata?: Record<string, unknown> | null;
    /** Explicit lineage for this version — never inferred from order. */
    parentVersionIds?: string[] | null;
    /** See `VersionConflictError` — omitted preserves today's behavior. */
    expectedVersion?: number;
  },
): Promise<{
  artifactId: string;
  version: number;
  title: string;
  metadata: Record<string, unknown> | null;
  contentSha256: string | null;
}> {
  if (
    args.title === undefined &&
    args.content === undefined &&
    args.metadata === undefined
  ) {
    throw new Error(
      "Provide content, title, and/or metadata to revise the artifact",
    );
  }
  if (args.title !== undefined) {
    assertArtifactFieldSizes({ title: args.title });
  }
  const now = new Date();

  return await db.transaction(async (tx) => {
    const row = await reviseArtifactVersion(tx, args, now);
    return {
      artifactId: row.id,
      version: row.version,
      title: row.title,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      contentSha256: row.contentSha256,
    };
  });
}

/** Fetch by id WITHOUT an archived filter — archiving hides, it does not revoke. */
export async function getArtifact(
  db: ArtifactDb,
  artifactId: string,
): Promise<ArtifactRow | null> {
  const [row] = await db
    .select()
    .from(artifact)
    .where(eq(artifact.id, artifactId))
    .limit(1);
  return row ?? null;
}

export async function getArtifactVersion(
  db: ArtifactDb,
  artifactId: string,
  version: number,
): Promise<{
  title: string;
  content: string;
  version: number;
  metadata: Record<string, unknown> | null;
  parentVersionIds: string[] | null;
  contentSha256: string | null;
  source: unknown;
} | null> {
  const [row] = await db
    .select({
      title: artifactVersion.title,
      content: artifactVersion.content,
      source: artifactVersion.source,
      version: artifactVersion.version,
      metadata: artifactVersion.metadata,
      parentVersionIds: artifactVersion.parentVersionIds,
      contentSha256: artifactVersion.contentSha256,
    })
    .from(artifactVersion)
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.version, version),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...row,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    parentVersionIds: row.parentVersionIds ?? null,
  };
}

export type ArtifactVersionListItem = {
  version: number;
  title: string;
  authorId: string;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  parentVersionIds: string[] | null;
  contentSha256: string | null;
};

export type ListArtifactVersionsFilters = {
  cursor?: number;
  limit?: number;
};

/**
 * Version history, newest first, keyset-paginated by version number. Same
 * limit defaults/clamps as listArtifacts. Does not project content.
 */
export async function listArtifactVersions(
  db: ArtifactDb,
  artifactId: string,
  filters: ListArtifactVersionsFilters = {},
): Promise<{ versions: ArtifactVersionListItem[]; nextCursor: string | null }> {
  const limit = filters.limit ?? DEFAULT_LIST_LIMIT;
  const conditions: SQL[] = [eq(artifactVersion.artifactId, artifactId)];
  if (filters.cursor !== undefined) {
    conditions.push(lt(artifactVersion.version, filters.cursor));
  }

  const fetched = await db
    .select({
      version: artifactVersion.version,
      title: artifactVersion.title,
      authorId: artifactVersion.authorId,
      createdAt: artifactVersion.createdAt,
      metadata: artifactVersion.metadata,
      parentVersionIds: artifactVersion.parentVersionIds,
      contentSha256: artifactVersion.contentSha256,
    })
    .from(artifactVersion)
    .where(and(...conditions))
    .orderBy(desc(artifactVersion.version))
    .limit(limit + 1);

  const page = fetched.slice(0, limit);
  const versions = page.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    parentVersionIds: r.parentVersionIds ?? null,
  }));
  if (fetched.length <= limit) return { versions, nextCursor: null };
  const last = page[page.length - 1]!;
  return { versions, nextCursor: String(last.version) };
}

/**
 * Archive (soft-hide) or unarchive. Idempotent: re-archiving never overwrites
 * the original timestamp, and unarchiving a visible artifact is a no-op.
 * Returns the row as it now stands in the database — never a locally
 * synthesized timestamp that may have lost a concurrent race.
 */
export async function setArtifactArchived(
  db: ArtifactDb,
  row: ArtifactRow,
  archive: boolean,
): Promise<ArtifactRow> {
  if (archive && row.archivedAt === null) {
    const [updated] = await db
      .update(artifact)
      .set({ archivedAt: new Date() })
      .where(and(eq(artifact.id, row.id), isNull(artifact.archivedAt)))
      .returning();
    if (updated) return updated;
    // Zero rows: a concurrent archive already won, or the row was archived
    // under a fresher view. Reload so the response matches durable state.
    return reloadArtifactRow(db, row.id);
  }
  if (!archive && row.archivedAt !== null) {
    const [updated] = await db
      .update(artifact)
      .set({ archivedAt: null })
      .where(eq(artifact.id, row.id))
      .returning();
    if (updated) return updated;
    return reloadArtifactRow(db, row.id);
  }
  return row;
}

async function reloadArtifactRow(
  db: ArtifactDb,
  artifactId: string,
): Promise<ArtifactRow> {
  const [current] = await db
    .select()
    .from(artifact)
    .where(eq(artifact.id, artifactId));
  if (!current) throw new ArtifactNotFoundError(artifactId);
  return current;
}

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type ListArtifactsFilters = {
  query?: string;
  sort?: string;
  kind?: string;
  ownerPrincipalId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  cursor?: { at: string; id: string };
  limit?: number;
  archived?: boolean;
};

/**
 * A date-only `yyyy-mm-dd` upper bound parses to UTC midnight, so a naive
 * `<= midnight` drops every row created later that same day (From=To=today
 * showing nothing). Treat date-only as inclusive end-of-day; honor a full
 * timestamp as given.
 */
const dateBound = (endOfDay: boolean) =>
  type("string").pipe((raw, ctx) => {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return ctx.error("a valid date");
    if (endOfDay && DATE_ONLY.test(raw)) parsed.setUTCHours(23, 59, 59, 999);
    return parsed;
  });

const ListCursor = type("string").pipe((raw, ctx) => {
  const separatorIndex = raw.lastIndexOf("__");
  const at = raw.slice(0, separatorIndex);
  const id = raw.slice(separatorIndex + 2);
  if (separatorIndex === -1 || Number.isNaN(Date.parse(at)) || id === "") {
    return ctx.error("a valid updatedAt__id cursor");
  }
  return { at, id };
});

// An unparseable limit takes the default; anything else is clamped into range,
// so `limit=0` means "one" rather than silently meaning "twenty".
const ListLimit = type("string").pipe((raw) => {
  const requested = Number(raw);
  return Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.floor(requested)), MAX_LIST_LIMIT)
    : DEFAULT_LIST_LIMIT;
});

/** The GET /artifacts query string, parsed and clamped at the edge. */
export const ListArtifactsQuery = type({
  "query?": "string",
  "sort?": "'newest' | 'oldest'",
  "kind?": "string",
  "ownerPrincipalId?": "string",
  "createdAfter?": dateBound(false),
  "createdBefore?": dateBound(true),
  "cursor?": ListCursor,
  limit: ListLimit.default(String(DEFAULT_LIST_LIMIT)),
  "archived?": "string",
}).pipe((q): ListArtifactsFilters => ({
  ...q,
  archived: q.archived === "true",
}));

/** GET /artifacts/:id/versions query — cursor is the last version seen (newest-first). */
export const ListArtifactVersionsQuery = type({
  "cursor?": type("string").pipe((raw, ctx) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return ctx.error("a positive integer version cursor");
    }
    return n;
  }),
  limit: ListLimit.default(String(DEFAULT_LIST_LIMIT)),
}).pipe((q): ListArtifactVersionsFilters => ({
  ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
  limit: q.limit,
}));

/**
 * Postgres `timestamptz` holds microseconds while a JS `Date` holds milliseconds,
 * so the cursor is rendered by Postgres at full precision — `Date#toISOString`
 * would truncate and skip/repeat rows inside a tie group. `to_char` on a
 * `timestamptz` renders in the session TimeZone, so project through
 * `AT TIME ZONE 'UTC'` first and stamp a literal `Z` — the keyset then stays
 * on the absolute instant under any session zone.
 */
export const CURSOR_TIMESTAMP_SQL = sql<string>`to_char(${artifact.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * A single row-value comparison so Postgres binds it as an Index Cond on
 * (tenant_id, updated_at, id); an OR-of-ranges lands in Filter and forces a
 * sort. The cursor value is cast to `timestamptz` so both sides are absolute
 * instants — stable under any session TimeZone and index-friendly on the
 * column as stored.
 */
function cursorCondition(
  { at, id }: { at: string; id: string },
  oldestFirst: boolean,
): SQL {
  const operator = oldestFirst ? sql`>` : sql`<`;
  return sql`(${artifact.updatedAt}, ${artifact.id}) ${operator} (${at}::timestamptz, ${id})`;
}

export async function listArtifacts(
  db: ArtifactDb,
  tenantId: string,
  filters: ListArtifactsFilters,
): Promise<{ rows: ArtifactListRow[]; nextCursor: string | null }> {
  const limit = filters.limit ?? DEFAULT_LIST_LIMIT;
  const oldestFirst = filters.sort === "oldest";

  const conditions: SQL[] = [
    eq(artifact.tenantId, tenantId),
    filters.archived
      ? isNotNull(artifact.archivedAt)
      : isNull(artifact.archivedAt),
  ];

  // ILIKE metacharacters in user input are escaped so a `%` searches for a
  // literal percent instead of matching everything.
  const query = (filters.query?.trim() ?? "")
    .slice(0, 200)
    .replace(/[%_\\]/g, "\\$&");
  if (query) {
    // Filter may match on content, but list never SELECTs the body column.
    conditions.push(
      or(
        ilike(artifact.title, `%${query}%`),
        ilike(artifact.content, `%${query}%`),
      )!,
    );
  }
  if (filters.kind) conditions.push(eq(artifact.kind, filters.kind));
  if (filters.ownerPrincipalId) {
    conditions.push(eq(artifact.ownerPrincipalId, filters.ownerPrincipalId));
  }
  if (filters.createdAfter !== undefined) {
    conditions.push(gte(artifact.createdAt, filters.createdAfter));
  }
  if (filters.createdBefore !== undefined) {
    conditions.push(lte(artifact.createdAt, filters.createdBefore));
  }
  if (filters.cursor !== undefined) {
    conditions.push(cursorCondition(filters.cursor, oldestFirst));
  }

  // Discovery projection: every column except `content`. Bodies can be huge;
  // clients that need one fetch detail, download, or tools.
  const { content: _content, ...listColumns } = getTableColumns(artifact);
  const fetched = await db
    .select({ ...listColumns, cursorAt: CURSOR_TIMESTAMP_SQL })
    .from(artifact)
    .where(and(...conditions))
    .orderBy(
      ...(oldestFirst
        ? [asc(artifact.updatedAt), asc(artifact.id)]
        : [desc(artifact.updatedAt), desc(artifact.id)]),
    )
    .limit(limit + 1);

  const page = fetched.slice(0, limit);
  const rows: ArtifactListRow[] = page.map(
    ({ cursorAt: _cursorAt, ...row }) => row,
  );
  if (fetched.length <= limit) return { rows, nextCursor: null };
  const last = page[page.length - 1]!;
  return { rows, nextCursor: `${last.cursorAt}__${last.id}` };
}

/**
 * Shared by `findArtifactByTitle` and `findOrVersionArtifact` — the latter
 * runs it against a transaction that already holds the find-or-version
 * advisory lock, so it takes `ArtifactDb | ArtifactTx` rather than forcing a
 * second, unlocked read.
 */
async function selectArtifactByTitle(
  queryable: ArtifactDb | ArtifactTx,
  tenantId: string,
  title: string,
  kind?: string,
): Promise<{ artifactId: string; version: number } | null> {
  const conditions: SQL[] = [
    eq(artifact.tenantId, tenantId),
    eq(artifact.title, title),
    isNull(artifact.archivedAt),
  ];
  if (kind !== undefined) conditions.push(eq(artifact.kind, kind));

  const [row] = await queryable
    .select({ id: artifact.id, version: artifact.version })
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.updatedAt))
    .limit(1);
  return row ? { artifactId: row.id, version: row.version } : null;
}

/** Most recently updated visible artifact with this exact title, or null. */
export async function findArtifactByTitle(
  db: ArtifactDb,
  tenantId: string,
  title: string,
  kind?: string,
): Promise<{ artifactId: string; version: number } | null> {
  return selectArtifactByTitle(db, tenantId, title, kind);
}

/**
 * Postgres advisory locks taken with the two-`int4`-argument form use a
 * lock space that never collides with the single-`bigint`-argument form
 * `runArtifactMigrations` uses (see `migrations.ts`'s `LOCK_KEY`) — Postgres
 * guarantees the two spaces are disjoint. This namespace is therefore
 * `findOrVersionArtifact`'s alone; it must never change (a live change would
 * let a deployed writer stop serializing against an in-flight one).
 */
const FIND_OR_VERSION_LOCK_NAMESPACE = 0x0a27_1f05;

export type FindOrVersionArtifactArgs = {
  scope: ResolvedPrincipal;
  /** The human who owns a newly created artifact; null for agents with no owning member. Ignored on the revise path — the existing artifact keeps its owner. */
  ownerPrincipalId: string | null;
  kind: string;
  title: string;
  content: string;
  /** Ignored on the revise path — only a fresh artifact's provenance. */
  source: Record<string, unknown>;
  /** Opaque to the package; omit on revise to carry the prior version's metadata forward. */
  metadata?: Record<string, unknown> | null;
  /** Explicit lineage for this version — never inferred from order. */
  parentVersionIds?: string[] | null;
};

export type FindOrVersionArtifactResult = {
  artifact: ArtifactRow;
  /** Whether this call minted a new artifact or appended a version to one that already existed. */
  outcome: "created" | "revised";
};

/**
 * The atomic primitive behind "find an artifact by title, create it if
 * absent, add a version if present." The schema's only uniqueness is
 * (artifactId, version) — nothing constrains (tenantId, title, kind) — so a
 * plain read-then-write of that pattern races: two callers can both see NOT
 * FOUND and both create, leaving two artifacts with the same title. This
 * closes that race INSIDE the package instead of leaving every consumer to
 * hand-roll its own locking (as at least one already had to, with a database
 * advisory lock wrapping the same lookup-and-write).
 *
 * The whole lookup-then-write runs in one transaction, serialized on a
 * transaction-scoped advisory lock keyed by `(tenantId, kind, title)` (via
 * `hashtext`, in the namespace above) — so two concurrent calls for the same
 * triple never both pass the "does it exist" check before either writes.
 *
 * Collision semantics: the caller that acquires the lock first creates the
 * artifact; every other concurrent caller for the same `(tenantId, kind,
 * title)` blocks on the lock, then — once it can proceed — finds the row the
 * first caller just committed and revises it instead of creating a second
 * one. Two overlapping callers therefore always converge on ONE artifact:
 * the first call's content becomes version 1, and the second's becomes
 * version 2 (in whichever order the lock grants), never two rows with the
 * same title. A caller for a *different* tenant, kind, or title is never
 * blocked by this lock — the key is scoped to the exact triple.
 *
 * Archived artifacts are invisible to the lookup, same as
 * `findArtifactByTitle`: an archived match does not get silently revived, and
 * a fresh artifact is created instead.
 */
export async function findOrVersionArtifact(
  db: ArtifactDb,
  args: FindOrVersionArtifactArgs,
): Promise<FindOrVersionArtifactResult> {
  return await db.transaction(async (tx) => {
    // Unit-separator-joined so ("ab", "c", "d") cannot hash the same as
    // ("a", "bc", "d"). A collision would only cost an unrelated writer a
    // needless wait, never an incorrect result -- the query below re-checks
    // by real column equality -- but there is no reason to invite one.
    const lockKey = `${args.scope.tenantId}${args.kind}${args.title}`;
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(${FIND_OR_VERSION_LOCK_NAMESPACE}, hashtext(${lockKey}))
    `);

    const existing = await selectArtifactByTitle(
      tx,
      args.scope.tenantId,
      args.title,
      args.kind,
    );

    if (existing) {
      const row = await reviseArtifactVersion(
        tx,
        {
          scope: args.scope,
          artifactId: existing.artifactId,
          content: args.content,
          ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
          ...(args.parentVersionIds !== undefined
            ? { parentVersionIds: args.parentVersionIds }
            : {}),
        },
        new Date(),
      );
      return { artifact: row, outcome: "revised" };
    }

    const row = await createArtifact(tx, {
      scope: args.scope,
      ownerPrincipalId: args.ownerPrincipalId,
      kind: args.kind,
      title: args.title,
      content: args.content,
      source: args.source,
      ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      ...(args.parentVersionIds !== undefined
        ? { parentVersionIds: args.parentVersionIds }
        : {}),
    });
    return { artifact: row, outcome: "created" };
  });
}

/**
 * Run the display-only provenance decorator over serialized rows. One call so
 * no surface can serialize a row and forget the decorator. Accepts list items
 * (no content) and detail rows alike; display enrichment never affects what is
 * returned or who may see it.
 */
export async function enrich(
  decorate: (
    tenantId: string,
    rows: readonly SerializedArtifactBase[],
  ) => Promise<void>,
  tenantId: string,
  rows: SerializedArtifactBase[],
): Promise<void> {
  await decorate(tenantId, rows);
}
