import { describe, expect, test } from "bun:test";
import {
  ArtifactCountsIncompleteError,
  countArtifactsBySegments,
  MAX_COUNT_PAGES,
} from "./counts.js";
import { setArtifactArchived } from "./artifacts.js";
import { seedArtifact, testDb } from "./test-helpers.js";
import type { ArtifactDb } from "./db.js";
import { listArtifacts } from "./artifacts.js";

describe("countArtifactsBySegments", () => {
  test("returns just `all` when no segments are supplied", async () => {
    const db = await testDb();
    await seedArtifact(db, { kind: "document" });
    await seedArtifact(db, { kind: "document" });

    const counts = await countArtifactsBySegments(db, "acme", {});
    expect(counts).toEqual({ all: 2 });
  });

  test("tallies each row against every predicate", async () => {
    const db = await testDb();
    await seedArtifact(db, { kind: "document" });
    await seedArtifact(db, { kind: "document" });
    await seedArtifact(db, { kind: "sheet" });

    const counts = await countArtifactsBySegments(db, "acme", {
      document: (row) => row.kind === "document",
      sheet: (row) => row.kind === "sheet",
      routine: (row) => row.kind === "routine",
    });
    expect(counts).toEqual({ all: 3, document: 2, sheet: 1, routine: 0 });
  });

  // The walk pages at 100 rows/page — seed past that boundary so a passing
  // test proves the cursor loop, not just a single-page happy path.
  test("walks past a single page", async () => {
    const db = await testDb();
    await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        seedArtifact(db, { kind: "document", title: `doc-${i}` }),
      ),
    );

    const counts = await countArtifactsBySegments(db, "acme", {
      document: (row) => row.kind === "document",
    });
    expect(counts).toEqual({ all: 120, document: 120 });
  });

  test("never counts another tenant's artifacts", async () => {
    const db = await testDb();
    await seedArtifact(db, { tenantId: "acme" });
    await seedArtifact(db, { tenantId: "other" });

    const counts = await countArtifactsBySegments(db, "acme", {});
    expect(counts).toEqual({ all: 1 });
  });

  test("excludes archived artifacts, matching GET /artifacts' default view", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "document" });
    await seedArtifact(db, { kind: "document" });
    await setArtifactArchived(db, row, true);

    const counts = await countArtifactsBySegments(db, "acme", {});
    expect(counts).toEqual({ all: 1 });
  });

});

// `ArtifactCountsIncompleteError` and the page cap it backstops are exercised
// end to end at the route level (mount.test.ts), where the honest-503
// contract lives; the walk's cursor plumbing itself is real Postgres
// pagination, not something worth faking a stalled cursor for here.
test("MAX_COUNT_PAGES is the documented cap", () => {
  expect(MAX_COUNT_PAGES).toBe(200);
  expect(ArtifactCountsIncompleteError.prototype).toBeInstanceOf(Error);
});

// Sanity: countArtifactsBySegments' walk must agree with what GET /artifacts
// itself would page through — same underlying listArtifacts call, same
// exclusions.
test("agrees with listArtifacts' own row set", async () => {
  const db = await testDb();
  await seedArtifact(db, { kind: "document" });
  await seedArtifact(db, { kind: "sheet" });

  const [counts, page] = await Promise.all([
    countArtifactsBySegments(db, "acme", {}),
    listArtifacts(db, "acme", {}),
  ]);
  expect(counts.all).toBe(page.rows.length);
});
