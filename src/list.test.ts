import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type } from "arktype";
import {
  DEFAULT_LIST_LIMIT,
  listArtifacts,
  ListArtifactsQuery,
  MAX_LIST_LIMIT,
  serializeArtifactListItem,
  setArtifactArchived,
} from "./artifacts.js";
import { seedArtifact, seedSkillDraft, testDb } from "./test-helpers.js";
import type { ArtifactDb } from "./db.js";

/** Parse a raw query string the way the route does, failing the test on error. */
function parseQuery(query: Record<string, string>) {
  const parsed = ListArtifactsQuery(query);
  if (parsed instanceof type.errors) throw new Error(parsed.summary);
  return parsed;
}

/** Pin a row's timestamps so ordering and date filters are deterministic. */
async function setTimes(db: ArtifactDb, id: string, iso: string) {
  await db.execute(
    sql`UPDATE "artifacts"."artifact" SET "created_at" = ${iso}::timestamptz, "updated_at" = ${iso}::timestamptz WHERE "id" = ${id}`,
  );
}

describe("list projection", () => {
  // List is discovery, not bulk download: full bodies stay on detail/download/tools.
  test("omits content from listed rows even when the body is large", async () => {
    const db = await testDb();
    const large = "x".repeat(50_000);
    const seeded = await seedArtifact(db, { title: "Bulky", content: large });

    const page = await listArtifacts(db, "acme", {});
    expect(page.rows.map((r) => r.id)).toEqual([seeded.id]);
    const row = page.rows[0] as { id: string; content?: string; title?: string };
    // The list query must not select the body column at all.
    expect("content" in row).toBe(false);
    expect(row.content).toBeUndefined();
    // And the payload must not equal the seeded body if a serializer ever reintroduces a field.
    expect(row.content).not.toBe(large);

    const listed = serializeArtifactListItem(page.rows[0]!);
    expect("content" in listed).toBe(false);
    expect(listed.title).toBe("Bulky");
    expect(listed.id).toBe(seeded.id);
  });
});

describe("list filters", () => {
  test("hides archived by default and shows only archived when asked", async () => {
    const db = await testDb();
    const visible = await seedArtifact(db, { title: "Visible" });
    const hidden = await seedArtifact(db, { title: "Hidden" });
    await setArtifactArchived(db, hidden, true);

    const defaults = await listArtifacts(db, "acme", {});
    expect(defaults.rows.map((r) => r.id)).toEqual([visible.id]);

    const archived = await listArtifacts(db, "acme", { archived: true });
    expect(archived.rows.map((r) => r.id)).toEqual([hidden.id]);
  });

  test("never lists a skill-draft, even under an explicit kind filter", async () => {
    const db = await testDb();
    await seedSkillDraft(db, "Scratch");
    await seedArtifact(db, { title: "Real" });

    expect((await listArtifacts(db, "acme", {})).rows.length).toBe(1);
    expect(
      (await listArtifacts(db, "acme", { kind: "skill-draft" })).rows.length,
    ).toBe(0);
  });

  test("is tenant-scoped", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Ours" });
    await seedArtifact(db, { title: "Theirs", tenantId: "other" });

    const rows = (await listArtifacts(db, "acme", {})).rows;
    expect(rows.map((r) => r.title)).toEqual(["Ours"]);
  });

  test("search matches title or content and escapes ILIKE metacharacters", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Quarterly", content: "nothing" });
    await seedArtifact(db, { title: "Other", content: "mentions quarterly plans" });
    await seedArtifact(db, { title: "100%", content: "literal" });

    expect((await listArtifacts(db, "acme", { query: "quarter" })).rows.length).toBe(
      2,
    );
    const percent = await listArtifacts(db, "acme", { query: "%" });
    expect(percent.rows.map((r) => r.title)).toEqual(["100%"]);
  });

  test("a date-only createdBefore is inclusive to end-of-day", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Afternoon" });
    await setTimes(db, row.id, "2026-03-04T18:30:00Z");

    const sameDay = await listArtifacts(
      db,
      "acme",
      parseQuery({ createdAfter: "2026-03-04", createdBefore: "2026-03-04" }),
    );
    expect(sameDay.rows.map((r) => r.id)).toEqual([row.id]);
  });

  test("a full-timestamp createdBefore is honored exactly", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Afternoon" });
    await setTimes(db, row.id, "2026-03-04T18:30:00Z");

    const before = await listArtifacts(
      db,
      "acme",
      parseQuery({ createdBefore: "2026-03-04T12:00:00Z" }),
    );
    expect(before.rows.length).toBe(0);
  });

  test("an unparseable date is rejected by the query schema", () => {
    for (const query of [{ createdAfter: "nope" }, { createdBefore: "nope" }]) {
      expect(ListArtifactsQuery(query)).toBeInstanceOf(type.errors);
    }
  });

  test("filters by kind and by owner", async () => {
    const db = await testDb();
    const csv = await seedArtifact(db, { title: "Export", kind: "csv-export" });
    await seedArtifact(db, { title: "Doc" });
    const theirs = await seedArtifact(db, { title: "Bot", ownerPrincipalId: "agent-9" });

    expect(
      (await listArtifacts(db, "acme", { kind: "csv-export" })).rows.map((r) => r.id),
    ).toEqual([csv.id]);
    expect(
      (
        await listArtifacts(db, "acme", { ownerPrincipalId: "agent-9" })
      ).rows.map((r) => r.id),
    ).toEqual([theirs.id]);
  });
});

describe("list paging", () => {
  test("mints a keyset cursor and pages without gaps or repeats", async () => {
    const db = await testDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await seedArtifact(db, { title: `A${i}` });
      await setTimes(db, row.id, `2026-01-0${i + 1}T00:00:00Z`);
      ids.push(row.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<typeof listArtifacts>> = await listArtifacts(
        db,
        "acme",
        parseQuery({ limit: "2", ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...result.rows.map((r) => r.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeNull();
  });

  test("sort=oldest reverses the order and its cursor walks forward", async () => {
    const db = await testDb();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await seedArtifact(db, { title: `A${i}` });
      await setTimes(db, row.id, `2026-01-0${i + 1}T00:00:00Z`);
      ids.push(row.id);
    }

    const first = await listArtifacts(db, "acme", { sort: "oldest", limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    const second = await listArtifacts(
      db,
      "acme",
      parseQuery({ sort: "oldest", limit: "2", cursor: first.nextCursor! }),
    );
    expect(second.rows.map((r) => r.id)).toEqual([ids[2]]);
  });

  test("a malformed cursor is rejected by the query schema", () => {
    for (const cursor of ["garbage", "not-a-date__abc", `${new Date().toISOString()}__`]) {
      expect(ListArtifactsQuery({ cursor })).toBeInstanceOf(type.errors);
    }
  });

  test("limit is clamped to the ceiling and floored at one", async () => {
    const db = await testDb();
    await db.execute(sql`
      INSERT INTO "artifacts"."artifact" ("tenant_id", "principal_id", "owner_principal_id",
        "kind", "title", "content", "source", "version")
      SELECT 'acme', 'user-1', 'user-1', 'document', 'Bulk ' || i, 'body',
        '{"origin":"manual"}'::jsonb, 1
      FROM generate_series(1, ${MAX_LIST_LIMIT + 5}) AS i
    `);

    const huge = await listArtifacts(db, "acme", parseQuery({ limit: "10000" }));
    expect(huge.rows.length).toBe(MAX_LIST_LIMIT);
    expect(huge.nextCursor).not.toBeNull();

    const zero = await listArtifacts(db, "acme", parseQuery({ limit: "0" }));
    expect(zero.rows.length).toBe(1);

    // A non-numeric `?limit=` must take the default, not collapse to one row.
    const garbage = await listArtifacts(db, "acme", parseQuery({ limit: "abc" }));
    expect(garbage.rows.length).toBe(DEFAULT_LIST_LIMIT);

    // An absent limit defaults at the schema.
    expect(parseQuery({}).limit).toBe(DEFAULT_LIST_LIMIT);
  });

  test("pages one row at a time through rows separated only by microseconds", async () => {
    const db = await testDb();
    // Five rows inside the SAME millisecond, differing only in the microsecond
    // digits a JS Date cannot hold. A cursor round-tripped through `Date` would
    // render all five as ...:00.000Z and skip four of them.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await seedArtifact(db, { title: `Micro${i}` });
      await setTimes(db, row.id, `2026-01-01T00:00:00.00000${i}Z`);
      ids.push(row.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const result: Awaited<ReturnType<typeof listArtifacts>> = await listArtifacts(
        db,
        "acme",
        parseQuery({ limit: "1", ...(cursor ? { cursor } : {}) }),
      );
      seen.push(...result.rows.map((r) => r.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toEqual([...ids].reverse());
    expect(cursor).toBeNull();
  });

  test("the cursor carries microsecond precision, not a truncated Date", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Precise" });
    await setTimes(db, row.id, "2026-01-01T00:00:00.123456Z");
    await seedArtifact(db, { title: "Second" });

    const first = await listArtifacts(db, "acme", { limit: 1, sort: "oldest" });
    expect(first.nextCursor).toBe(`2026-01-01T00:00:00.123456Z__${row.id}`);
    expect(new Date(first.nextCursor!.slice(0, 27)).toISOString()).not.toBe(
      "2026-01-01T00:00:00.123456Z",
    );
  });

  /**
   * Zoneless `timestamp` columns reinterpret absolute instants as session wall
   * clocks on write. A non-UTC `TimeZone` then makes the cursor claim a false
   * `Z` and page against a different instant than the row stores. `timestamptz`
   * keeps the keyset stable under any session zone.
   */
  test("keyset cursor stays on the UTC instant under a non-UTC session TimeZone", async () => {
    const db = await testDb();
    await db.execute(sql`SET TimeZone = 'America/Los_Angeles'`);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const row = await seedArtifact(db, { title: `Zone${i}` });
        // Absolute UTC pins written the same way production dates arrive.
        await setTimes(db, row.id, `2026-01-0${i + 1}T12:00:00.000000Z`);
        ids.push(row.id);
      }

      const first = await listArtifacts(db, "acme", { limit: 1 });
      // Newest first: 2026-01-03 12:00 UTC — not the LA wall clock 04:00 with a
      // lying Z suffix.
      expect(first.rows.map((r) => r.id)).toEqual([ids[2]]);
      expect(first.nextCursor).toBe(`2026-01-03T12:00:00.000000Z__${ids[2]}`);

      const second = await listArtifacts(
        db,
        "acme",
        parseQuery({ limit: "1", cursor: first.nextCursor! }),
      );
      expect(second.rows.map((r) => r.id)).toEqual([ids[1]]);
      expect(second.nextCursor).toBe(`2026-01-02T12:00:00.000000Z__${ids[1]}`);

      const third = await listArtifacts(
        db,
        "acme",
        parseQuery({ limit: "1", cursor: second.nextCursor! }),
      );
      expect(third.rows.map((r) => r.id)).toEqual([ids[0]]);
      expect(third.nextCursor).toBeNull();

      // Date filters must also compare absolute instants, not session walls.
      const filtered = await listArtifacts(
        db,
        "acme",
        parseQuery({
          createdAfter: "2026-01-02T00:00:00Z",
          createdBefore: "2026-01-02T23:59:59Z",
        }),
      );
      expect(filtered.rows.map((r) => r.id)).toEqual([ids[1]]);
    } finally {
      await db.execute(sql`SET TimeZone = 'UTC'`);
    }
  });
});
