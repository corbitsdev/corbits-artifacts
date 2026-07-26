import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  ArtifactFilterError,
  DEFAULT_LIST_LIMIT,
  listArtifacts,
  MAX_LIST_LIMIT,
  setArtifactArchived,
} from "../src/artifacts.js";
import { fakeIdentity, seedArtifact, seedSkillDraft, testDb } from "./helpers.js";
import type { ArtifactDb } from "../src/db.js";

const identity = fakeIdentity();

/** Pin a row's timestamps so ordering and date filters are deterministic. */
async function setTimes(db: ArtifactDb, id: string, iso: string) {
  await db.execute(
    sql`UPDATE "artifact" SET "created_at" = ${iso}::timestamptz, "updated_at" = ${iso}::timestamptz WHERE "id" = ${id}`,
  );
}

describe("list filters", () => {
  test("hides archived by default and shows only archived when asked", async () => {
    const db = await testDb();
    const visible = await seedArtifact(db, { title: "Visible" });
    const hidden = await seedArtifact(db, { title: "Hidden" });
    await setArtifactArchived(db, hidden, true);

    const defaults = await listArtifacts(db, identity, "acme", {});
    expect(defaults.rows.map((r) => r.id)).toEqual([visible.id]);

    const archived = await listArtifacts(db, identity, "acme", { archived: true });
    expect(archived.rows.map((r) => r.id)).toEqual([hidden.id]);
  });

  test("never lists a skill-draft, even under an explicit kind filter", async () => {
    const db = await testDb();
    await seedSkillDraft(db, "Scratch");
    await seedArtifact(db, { title: "Real" });

    expect((await listArtifacts(db, identity, "acme", {})).rows.length).toBe(1);
    expect(
      (await listArtifacts(db, identity, "acme", { kind: "skill-draft" })).rows.length,
    ).toBe(0);
  });

  test("is tenant-scoped", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Ours" });
    await seedArtifact(db, { title: "Theirs", tenantId: "other" });

    const rows = (await listArtifacts(db, identity, "acme", {})).rows;
    expect(rows.map((r) => r.title)).toEqual(["Ours"]);
  });

  test("search matches title or content and escapes ILIKE metacharacters", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Quarterly", content: "nothing" });
    await seedArtifact(db, { title: "Other", content: "mentions quarterly plans" });
    await seedArtifact(db, { title: "100%", content: "literal" });

    expect((await listArtifacts(db, identity, "acme", { query: "quarter" })).rows.length).toBe(
      2,
    );
    const percent = await listArtifacts(db, identity, "acme", { query: "%" });
    expect(percent.rows.map((r) => r.title)).toEqual(["100%"]);
  });

  test("a date-only createdBefore is inclusive to end-of-day", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Afternoon" });
    await setTimes(db, row.id, "2026-03-04T18:30:00Z");

    const sameDay = await listArtifacts(db, identity, "acme", {
      createdAfter: "2026-03-04",
      createdBefore: "2026-03-04",
    });
    expect(sameDay.rows.map((r) => r.id)).toEqual([row.id]);
  });

  test("a full-timestamp createdBefore is honored exactly", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Afternoon" });
    await setTimes(db, row.id, "2026-03-04T18:30:00Z");

    const before = await listArtifacts(db, identity, "acme", {
      createdBefore: "2026-03-04T12:00:00Z",
    });
    expect(before.rows.length).toBe(0);
  });

  test("an unparseable date is a filter error", async () => {
    const db = await testDb();
    for (const filters of [{ createdAfter: "nope" }, { createdBefore: "nope" }]) {
      await expect(listArtifacts(db, identity, "acme", filters)).rejects.toBeInstanceOf(
        ArtifactFilterError,
      );
    }
  });

  test("creatorKind with no matching principals excludes everything", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Mine" });

    const none = await listArtifacts(db, identity, "acme", { creatorKind: "agent" });
    expect(none.rows.length).toBe(0);
  });

  test("creatorKind narrows to the matching owner principals", async () => {
    const db = await testDb();
    const mine = await seedArtifact(db, { title: "Mine" });
    await seedArtifact(db, { title: "Bot", ownerPrincipalId: "agent-9" });

    const users = await listArtifacts(
      db,
      fakeIdentity({ principalIdsByKind: async () => ["user-1"] }),
      "acme",
      { creatorKind: "user" },
    );
    expect(users.rows.map((r) => r.id)).toEqual([mine.id]);
  });

  test("filters by kind and by owner", async () => {
    const db = await testDb();
    const csv = await seedArtifact(db, { title: "Export", kind: "csv-export" });
    await seedArtifact(db, { title: "Doc" });
    const theirs = await seedArtifact(db, { title: "Bot", ownerPrincipalId: "agent-9" });

    expect(
      (await listArtifacts(db, identity, "acme", { kind: "csv-export" })).rows.map((r) => r.id),
    ).toEqual([csv.id]);
    expect(
      (
        await listArtifacts(db, identity, "acme", { ownerPrincipalId: "agent-9" })
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
        identity,
        "acme",
        { limit: 2, ...(cursor ? { cursor } : {}) },
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

    const first = await listArtifacts(db, identity, "acme", { sort: "oldest", limit: 2 });
    expect(first.rows.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    const second = await listArtifacts(db, identity, "acme", {
      sort: "oldest",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.rows.map((r) => r.id)).toEqual([ids[2]]);
  });

  test("a malformed cursor is a filter error", async () => {
    const db = await testDb();
    for (const cursor of ["garbage", "not-a-date__abc", `${new Date().toISOString()}__`]) {
      await expect(
        listArtifacts(db, identity, "acme", { cursor }),
      ).rejects.toBeInstanceOf(ArtifactFilterError);
    }
  });

  test("limit is clamped to the ceiling and floored at one", async () => {
    const db = await testDb();
    await db.execute(sql`
      INSERT INTO "artifact" ("tenant_id", "principal_id", "owner_principal_id",
        "kind", "title", "content", "source", "version")
      SELECT 'acme', 'user-1', 'user-1', 'document', 'Bulk ' || i, 'body',
        '{"origin":"manual"}'::jsonb, 1
      FROM generate_series(1, ${MAX_LIST_LIMIT + 5}) AS i
    `);

    const huge = await listArtifacts(db, identity, "acme", { limit: 10_000 });
    expect(huge.rows.length).toBe(MAX_LIST_LIMIT);
    expect(huge.nextCursor).not.toBeNull();

    const zero = await listArtifacts(db, identity, "acme", { limit: 0 });
    expect(zero.rows.length).toBe(1);

    // A non-numeric `?limit=` reaches here as NaN and must take the default,
    // not collapse to one row.
    const garbage = await listArtifacts(db, identity, "acme", { limit: Number("abc") });
    expect(garbage.rows.length).toBe(DEFAULT_LIST_LIMIT);
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
        identity,
        "acme",
        { limit: 1, ...(cursor ? { cursor } : {}) },
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

    const first = await listArtifacts(db, identity, "acme", { limit: 1, sort: "oldest" });
    expect(first.nextCursor).toBe(`2026-01-01T00:00:00.123456Z__${row.id}`);
    expect(new Date(first.nextCursor!.slice(0, 27)).toISOString()).not.toBe(
      "2026-01-01T00:00:00.123456Z",
    );
  });
});
