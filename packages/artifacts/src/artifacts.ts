import "./arktype.js";
import { type } from "arktype";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { ArtifactDb, ArtifactTx } from "./db.js";
import { artifact, artifactVersion, type ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal, Identity } from "./ports.js";
import {
  parseWebSiteContentJson,
  serializeWebSiteContent,
  WEB_SITE_KIND,
} from "./web-site.js";

/**
 * Internal skill-authoring scratch. Every surface here treats it as NOT FOUND
 * rather than forbidden: its existence is not the caller's business, and a 403
 * would leak that an id is real.
 */
export const SKILL_DRAFT_KIND = "skill-draft";

/** Coarse producer classes. `unknown` covers rows written before provenance. */
export const ARTIFACT_ORIGINS = [
  "workflow",
  "agent",
  "manual",
  "imported",
  "unknown",
] as const;
const KnownOriginSource = type({ origin: type.enumerated(...ARTIFACT_ORIGINS) });
// A jsonb value that is an object — not null, not an array, not a scalar.
const JsonObject = type("object").narrow(
  (value): value is Record<string, unknown> => !Array.isArray(value),
);

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

export type SerializedArtifact = {
  id: string;
  kind: string;
  title: string;
  content: string;
  source: Record<string, unknown> & { origin: string };
  version: number;
  ownerPrincipalId: string | null;
  ownerName: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeArtifact(row: ArtifactRow): SerializedArtifact {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    source: normalizeSource(row.source),
    version: row.version,
    ownerPrincipalId: row.ownerPrincipalId,
    ownerName: null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `web_site` content is round-tripped through its schema; other kinds pass through. */
function normalizeContentForKind(kind: string, content: string): string {
  if (kind === WEB_SITE_KIND) {
    return serializeWebSiteContent(parseWebSiteContentJson(content));
  }
  return content;
}

export type CreateArtifactArgs = {
  scope: ResolvedPrincipal;
  /** The human who owns this artifact; null for agents with no owning member. */
  ownerPrincipalId: string | null;
  kind: string;
  title: string;
  content: string;
  source: Record<string, unknown>;
};

/**
 * Create an artifact AND its version 1 in one transaction. Version 1 is
 * eager, never lazy: a pinned read of version 1 must resolve for every
 * artifact, including one that is never revised.
 */
export async function createArtifact(
  tx: ArtifactTx,
  args: CreateArtifactArgs,
): Promise<ArtifactRow> {
  if (args.kind === SKILL_DRAFT_KIND) {
    throw new Error("skill-draft artifacts are not created through this module");
  }
  const content = normalizeContentForKind(args.kind, args.content);
  const now = new Date();

  const [row] = await tx
    .insert(artifact)
    .values({
      tenantId: args.scope.tenantId,
      principalId: args.scope.principalId,
      ownerPrincipalId: args.ownerPrincipalId,
      kind: args.kind,
      title: args.title,
      content,
      source: args.source,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("Failed to create artifact");

  await tx.insert(artifactVersion).values({
    artifactId: row.id,
    version: 1,
    title: args.title,
    content,
    authorId: args.scope.principalId,
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
 * Revise an artifact: bump `version`, append a history row. The artifact row is
 * locked `FOR UPDATE` so concurrent writers serialize instead of both computing
 * the same next version; the (artifactId, version) unique index is the second
 * half of that guard.
 *
 * Archived and skill-draft artifacts present as NOT FOUND — an agent holding a
 * stale id must not silently revise something the user put away.
 */
export async function writeArtifactVersion(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    artifactId: string;
    title?: string;
    content?: string;
  },
): Promise<{ artifactId: string; version: number; title: string }> {
  if (args.title === undefined && args.content === undefined) {
    throw new Error("Provide content and/or title to revise the artifact");
  }
  const now = new Date();

  return await db.transaction(async (tx) => {
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

    if (
      !existing ||
      existing.archivedAt !== null ||
      existing.kind === SKILL_DRAFT_KIND
    ) {
      throw new ArtifactNotFoundError(args.artifactId);
    }

    const version = existing.version + 1;
    const title = args.title ?? existing.title;
    const content =
      args.content === undefined
        ? existing.content
        : normalizeContentForKind(existing.kind, args.content);

    await tx
      .update(artifact)
      .set({ title, content, version, updatedAt: now })
      .where(eq(artifact.id, args.artifactId));

    await tx.insert(artifactVersion).values({
      artifactId: args.artifactId,
      version,
      title,
      content,
      authorId: args.scope.principalId,
      createdAt: now,
    });

    return { artifactId: args.artifactId, version, title };
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
): Promise<{ title: string; content: string; version: number } | null> {
  const [row] = await db
    .select({
      title: artifactVersion.title,
      content: artifactVersion.content,
      version: artifactVersion.version,
    })
    .from(artifactVersion)
    .where(
      and(
        eq(artifactVersion.artifactId, artifactId),
        eq(artifactVersion.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listArtifactVersions(
  db: ArtifactDb,
  artifactId: string,
): Promise<{ version: number; title: string; authorId: string; createdAt: string }[]> {
  const rows = await db
    .select({
      version: artifactVersion.version,
      title: artifactVersion.title,
      authorId: artifactVersion.authorId,
      createdAt: artifactVersion.createdAt,
    })
    .from(artifactVersion)
    .where(eq(artifactVersion.artifactId, artifactId))
    .orderBy(desc(artifactVersion.version));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
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
  creatorKind?: "user" | "agent";
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
  "creatorKind?": "'user' | 'agent'",
  "createdAfter?": dateBound(false),
  "createdBefore?": dateBound(true),
  "cursor?": ListCursor,
  limit: ListLimit.default(String(DEFAULT_LIST_LIMIT)),
  "archived?": "string",
}).pipe(
  (q): ListArtifactsFilters => ({ ...q, archived: q.archived === "true" }),
);

/**
 * Postgres `timestamp` holds microseconds while a JS `Date` holds milliseconds,
 * so the cursor is rendered by Postgres at full precision — `Date#toISOString`
 * would truncate and skip/repeat rows inside a tie group. `updated_at` is a
 * zoneless UTC column, so no `AT TIME ZONE 'UTC'` here: that would produce a
 * `timestamptz` rendered in the session's zone. The literal `Z` states the
 * column's contents are UTC.
 */
export const CURSOR_TIMESTAMP_SQL = sql<string>`to_char(${artifact.updatedAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * A single row-value comparison so Postgres binds it as an Index Cond on
 * (tenant_id, updated_at, id); an OR-of-ranges lands in Filter and forces a
 * sort. The cursor value is cast to the zoneless column's type (`::timestamp`
 * accepts and discards the trailing `Z`); casting the column to `timestamptz`
 * instead would apply the session's zone and defeat the index.
 */
function cursorCondition(
  { at, id }: { at: string; id: string },
  oldestFirst: boolean,
): SQL {
  const operator = oldestFirst ? sql`>` : sql`<`;
  return sql`(${artifact.updatedAt}, ${artifact.id}) ${operator} (${at}::timestamp, ${id})`;
}

export async function listArtifacts(
  db: ArtifactDb,
  identity: Identity,
  tenantId: string,
  filters: ListArtifactsFilters,
): Promise<{ rows: ArtifactRow[]; nextCursor: string | null }> {
  const limit = filters.limit ?? DEFAULT_LIST_LIMIT;
  const oldestFirst = filters.sort === "oldest";

  const conditions: SQL[] = [
    eq(artifact.tenantId, tenantId),
    filters.archived ? isNotNull(artifact.archivedAt) : isNull(artifact.archivedAt),
    // Never listed, even under an explicit kind=skill-draft filter.
    ne(artifact.kind, SKILL_DRAFT_KIND),
  ];

  // ILIKE metacharacters in user input are escaped so a `%` searches for a
  // literal percent instead of matching everything.
  const query = (filters.query?.trim() ?? "").slice(0, 200).replace(/[%_\\]/g, "\\$&");
  if (query) {
    conditions.push(
      or(ilike(artifact.title, `%${query}%`), ilike(artifact.content, `%${query}%`))!,
    );
  }
  if (filters.kind) conditions.push(eq(artifact.kind, filters.kind));
  if (filters.ownerPrincipalId) {
    conditions.push(eq(artifact.ownerPrincipalId, filters.ownerPrincipalId));
  }
  if (filters.creatorKind) {
    // Creator kind is a facet of the owner principal, not a column here, so it
    // folds in as an ownerPrincipalId membership test. NO matching principals
    // must exclude everything, not fall through to unfiltered.
    const ids = await identity.principalIdsByKind(tenantId, filters.creatorKind);
    conditions.push(
      ids.length > 0 ? inArray(artifact.ownerPrincipalId, ids) : sql`false`,
    );
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

  const fetched = await db
    .select({ ...getTableColumns(artifact), cursorAt: CURSOR_TIMESTAMP_SQL })
    .from(artifact)
    .where(and(...conditions))
    .orderBy(
      ...(oldestFirst
        ? [asc(artifact.updatedAt), asc(artifact.id)]
        : [desc(artifact.updatedAt), desc(artifact.id)]),
    )
    .limit(limit + 1);

  const page = fetched.slice(0, limit);
  const rows: ArtifactRow[] = page.map(({ cursorAt: _cursorAt, ...row }) => row);
  if (fetched.length <= limit) return { rows, nextCursor: null };
  const last = page[page.length - 1]!;
  return { rows, nextCursor: `${last.cursorAt}__${last.id}` };
}

/** Most recently updated visible artifact with this exact title, or null. */
export async function findArtifactByTitle(
  db: ArtifactDb,
  tenantId: string,
  title: string,
  kind?: string,
): Promise<{ artifactId: string; version: number } | null> {
  if (kind === SKILL_DRAFT_KIND) return null;
  const conditions: SQL[] = [
    eq(artifact.tenantId, tenantId),
    eq(artifact.title, title),
    ne(artifact.kind, SKILL_DRAFT_KIND),
    isNull(artifact.archivedAt),
  ];
  if (kind !== undefined) conditions.push(eq(artifact.kind, kind));

  const [row] = await db
    .select({ id: artifact.id, version: artifact.version })
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.updatedAt))
    .limit(1);
  return row ? { artifactId: row.id, version: row.version } : null;
}

/**
 * Attach owner display names and run the display-only provenance decorator.
 * One call so no surface can serialize a row and forget half the enrichment.
 */
export async function enrich(
  identity: Identity,
  decorate: (tenantId: string, rows: SerializedArtifact[]) => Promise<void>,
  tenantId: string,
  rows: SerializedArtifact[],
): Promise<void> {
  const ownerIds = [
    ...new Set(rows.map((r) => r.ownerPrincipalId).filter((id) => id !== null)),
  ];
  if (ownerIds.length > 0) {
    const names = await identity.ownerNames(tenantId, ownerIds);
    for (const row of rows) {
      if (row.ownerPrincipalId !== null) {
        row.ownerName = names.get(row.ownerPrincipalId) ?? null;
      }
    }
  }
  await decorate(tenantId, rows);
}
