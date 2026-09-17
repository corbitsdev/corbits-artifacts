import type { ArtifactDb } from "./db.js";
import { listArtifacts, type ArtifactListRow } from "./artifacts.js";

// Safety cap on the counts walk: 200 pages of MAX_LIST_LIMIT rows each is
// tens of thousands of artifacts, far past any real tenant today. A tenant
// that legitimately exceeds it — or a store whose cursor stops advancing —
// gets an honest "can't count that" instead of a route that hangs or lies
// with a partial total.
export const MAX_COUNT_PAGES = 200;

/** One page's worth of rows per walk step, matching `listArtifacts`' own cap. */
const COUNT_PAGE_LIMIT = 100;

/** Thrown when the counts walk cannot finish honestly — capped out or the
 * underlying cursor stopped advancing — rather than ever returning a partial
 * count as if it were the whole tenant. */
export class ArtifactCountsIncompleteError extends Error {}

/** A host-supplied predicate bucketing rows into a named segment. The
 * segment taxonomy (what a "sheet" or "routine" artifact is) is entirely
 * host-owned — this module only walks the tenant's artifacts once and tallies
 * whichever predicates the host hands it. */
export type ArtifactCountSegments = Readonly<
  Record<string, (row: ArtifactListRow) => boolean>
>;

/** Per-segment counts plus the tenant total. Always includes `all`, plus one
 * key per segment name passed to `countArtifactsBySegments`. */
export type ArtifactCounts = { readonly all: number } & Readonly<
  Record<string, number>
>;

/**
 * Walks every page of a tenant's (non-archived) artifacts — the same rows
 * `GET /artifacts` would page through, so a row is never double-counted or
 * missed at a page boundary — and buckets each row by every predicate in
 * `segments`. Real counts over the full tenant list, not an estimate from one
 * page.
 */
export async function countArtifactsBySegments(
  db: ArtifactDb,
  tenantId: string,
  segments: ArtifactCountSegments,
): Promise<ArtifactCounts> {
  let all = 0;
  const bySegment: Record<string, number> = Object.fromEntries(
    Object.keys(segments).map((name) => [name, 0]),
  );

  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await listArtifacts(db, tenantId, {
      limit: COUNT_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor: parseCursor(cursor) } : {}),
    });
    pages += 1;
    for (const row of page.rows) {
      all += 1;
      for (const [name, predicate] of Object.entries(segments)) {
        if (predicate(row)) bySegment[name] = (bySegment[name] ?? 0) + 1;
      }
    }
    if (page.nextCursor === null) break;
    if (page.nextCursor === cursor) {
      throw new ArtifactCountsIncompleteError(
        `Artifact list cursor for tenant ${tenantId} did not advance past page ${pages}`,
      );
    }
    if (pages >= MAX_COUNT_PAGES) {
      throw new ArtifactCountsIncompleteError(
        `Artifact list for tenant ${tenantId} exceeds ${MAX_COUNT_PAGES} pages — counts would be incomplete`,
      );
    }
    cursor = page.nextCursor;
  }

  return { all, ...bySegment };
}

/** `listArtifacts`' cursor filter wants `{ at, id }`, not the opaque
 * `at__id` string it hands back — mirror its own encoding here. */
function parseCursor(raw: string): { at: string; id: string } {
  const sep = raw.lastIndexOf("__");
  return { at: raw.slice(0, sep), id: raw.slice(sep + 2) };
}
