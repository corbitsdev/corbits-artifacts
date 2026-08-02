import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  ArtifactNotFoundError,
  ArtifactSizeError,
  createArtifact,
  findArtifactByTitle,
  findOrVersionArtifact,
  getArtifactVersion,
  listArtifactVersions,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_TITLE_LENGTH,
  normalizeSource,
  serializeArtifact,
  setArtifactArchived,
  writeArtifactVersion,
} from "./artifacts.js";
import { artifact, artifactVersion } from "./schema.js";
import { seedArtifact, seedSkillDraft, SCOPE, testDb } from "./test-helpers.js";

describe("create", () => {
  test("writes version 1 eagerly, so a pinned read of v1 resolves immediately", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Brief", content: "first" });

    expect(row.version).toBe(1);
    const pinned = await getArtifactVersion(db, row.id, 1);
    expect(pinned).toEqual({ title: "Brief", content: "first", version: 1 });
  });

  test("refuses to mint a skill-draft", async () => {
    const db = await testDb();
    await expect(
      db.transaction((tx) =>
        createArtifact(tx, {
          scope: SCOPE,
          ownerPrincipalId: null,
          kind: "skill-draft",
          title: "x",
          content: "y",
          source: { origin: "agent" },
        }),
      ),
    ).rejects.toThrow(/skill-draft/);
  });

  test("a failure after the bytes are written rolls the whole artifact back", async () => {
    const db = await testDb();
    await expect(
      db.transaction(async (tx) => {
        await createArtifact(tx, {
          scope: SCOPE,
          ownerPrincipalId: null,
          kind: "file",
          title: "orphan.pdf",
          content: "",
          source: { origin: "imported" },
        });
        throw new Error("parse failed");
      }),
    ).rejects.toThrow("parse failed");

    const rows = await db.select().from(artifactVersion);
    expect(rows.length).toBe(0);
  });

  test("normalizes web_site content through its schema", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      kind: "web_site",
      content: JSON.stringify({ files: { "/index.html": "<p>hi</p>" } }),
    });
    expect(JSON.parse(row.content)).toEqual({
      entry: "index.html",
      files: { "index.html": "<p>hi</p>" },
    });
  });
  test("rejects oversize title and content before insert", async () => {
    const db = await testDb();
    await expect(
      db.transaction((tx) =>
        createArtifact(tx, {
          scope: SCOPE,
          ownerPrincipalId: SCOPE.principalId,
          kind: "document",
          title: "x".repeat(MAX_ARTIFACT_TITLE_LENGTH + 1),
          content: "ok",
          source: { origin: "manual" },
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactSizeError);

    await expect(
      db.transaction((tx) =>
        createArtifact(tx, {
          scope: SCOPE,
          ownerPrincipalId: SCOPE.principalId,
          kind: "document",
          title: "ok",
          content: "x".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1),
          source: { origin: "manual" },
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactSizeError);
  });
});

describe("versioning", () => {
  test("bumps the version and appends history", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });

    const second = await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      content: "v2",
    });
    expect(second.version).toBe(2);
    expect(second.title).toBe("Draft");

    const history = await listArtifactVersions(db, row.id);
    expect(history.versions.map((h) => h.version)).toEqual([2, 1]);
    expect(history.nextCursor).toBeNull();
    expect((await getArtifactVersion(db, row.id, 1))?.content).toBe("v1");
    expect((await getArtifactVersion(db, row.id, 2))?.content).toBe("v2");
  });

  test("paginates version history newest-first without content", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "v2" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "v3" });

    const page1 = await listArtifactVersions(db, row.id, { limit: 2 });
    expect(page1.versions.map((v) => v.version)).toEqual([3, 2]);
    expect(page1.versions[0]).not.toHaveProperty("content");
    expect(page1.nextCursor).toBe("2");

    const page2 = await listArtifactVersions(db, row.id, {
      limit: 2,
      cursor: Number(page1.nextCursor),
    });
    expect(page2.versions.map((v) => v.version)).toEqual([1]);
    expect(page2.nextCursor).toBeNull();
  });

  test("rejects oversize revise fields", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await expect(
      writeArtifactVersion(db, {
        scope: SCOPE,
        artifactId: row.id,
        title: "x".repeat(MAX_ARTIFACT_TITLE_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(ArtifactSizeError);
    await expect(
      writeArtifactVersion(db, {
        scope: SCOPE,
        artifactId: row.id,
        content: "x".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(ArtifactSizeError);
  });

  test("concurrent writers serialize into distinct versions", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "base" });

    const results = await Promise.all([
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "a" }),
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "b" }),
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "c" }),
    ]);
    expect(results.map((r) => r.version).sort()).toEqual([2, 3, 4]);

    const rows = await db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, row.id));
    expect(rows.length).toBe(4);
  });

  test("an archived artifact presents as not found, not forbidden", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await setArtifactArchived(db, row, true);

    await expect(
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "x" }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("a skill-draft presents as not found", async () => {
    const db = await testDb();
    const id = await seedSkillDraft(db, "scratch");
    await expect(
      writeArtifactVersion(db, { scope: SCOPE, artifactId: id, content: "x" }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("another tenant's artifact presents as not found", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { tenantId: "other" });
    await expect(
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "x" }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("refuses a revision that changes nothing", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await expect(
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id }),
    ).rejects.toThrow(/content and\/or title/);
  });
});

describe("archive", () => {
  test("is idempotent: re-archiving keeps the original timestamp", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);

    const archived = await setArtifactArchived(db, row, true);
    expect(archived.archivedAt).not.toBeNull();
    const again = await setArtifactArchived(db, archived, true);
    expect(again.archivedAt?.getTime()).toBe(archived.archivedAt!.getTime());

    const restored = await setArtifactArchived(db, again, false);
    expect(restored.archivedAt).toBeNull();
    expect((await setArtifactArchived(db, restored, false)).archivedAt).toBeNull();
  });

  test("returned archivedAt matches durable DB state", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);

    const archived = await setArtifactArchived(db, row, true);
    const [durable] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, row.id));
    expect(durable?.archivedAt).not.toBeNull();
    expect(archived.archivedAt?.getTime()).toBe(durable!.archivedAt!.getTime());
  });

  test("reports durable archivedAt when a concurrent archive already won", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);

    // Race winner already wrote a known timestamp; caller still holds a
    // pre-archive snapshot (archivedAt null).
    const winnerAt = new Date("2020-01-15T12:00:00.000Z");
    await db
      .update(artifact)
      .set({ archivedAt: winnerAt })
      .where(eq(artifact.id, row.id));

    const result = await setArtifactArchived(db, row, true);

    expect(result.archivedAt?.toISOString()).toBe(winnerAt.toISOString());
    const [durable] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, row.id));
    expect(result.archivedAt?.getTime()).toBe(durable!.archivedAt!.getTime());
    // Original timestamp must not be overwritten by the late archive attempt.
    expect(durable!.archivedAt?.toISOString()).toBe(winnerAt.toISOString());
  });

  test("concurrent archive calls all return the durable timestamp", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);

    const results = await Promise.all([
      setArtifactArchived(db, row, true),
      setArtifactArchived(db, row, true),
      setArtifactArchived(db, row, true),
    ]);

    const [durable] = await db
      .select()
      .from(artifact)
      .where(eq(artifact.id, row.id));
    expect(durable?.archivedAt).not.toBeNull();
    const durableMs = durable!.archivedAt!.getTime();
    for (const result of results) {
      expect(result.archivedAt?.getTime()).toBe(durableMs);
    }
  });
});

describe("find by title", () => {
  test("returns the most recently updated visible match", async () => {
    const db = await testDb();
    const older = await seedArtifact(db, { title: "Report" });
    await seedArtifact(db, { title: "Report" });
    await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: older.id,
      content: "touched",
    });

    expect((await findArtifactByTitle(db, "acme", "Report"))?.artifactId).toBe(older.id);
  });

  test("never returns an archived or skill-draft artifact", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Hidden" });
    await setArtifactArchived(db, row, true);
    await seedSkillDraft(db, "Scratch");

    expect(await findArtifactByTitle(db, "acme", "Hidden")).toBeNull();
    expect(await findArtifactByTitle(db, "acme", "Scratch")).toBeNull();
    expect(await findArtifactByTitle(db, "acme", "Report", "skill-draft")).toBeNull();
  });

  test("honors a kind filter", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Same", kind: "document" });
    const csv = await seedArtifact(db, { title: "Same", kind: "csv-export" });
    expect((await findArtifactByTitle(db, "acme", "Same", "csv-export"))?.artifactId).toBe(
      csv.id,
    );
  });
});

describe("find-or-version", () => {
  test("creates when no match exists", async () => {
    const db = await testDb();
    const result = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principalId,
      kind: "document",
      title: "Report",
      content: "v1",
      source: { origin: "agent" },
    });

    expect(result.outcome).toBe("created");
    expect(result.artifact.version).toBe(1);
    expect(result.artifact.content).toBe("v1");
  });

  test("revises the existing match instead of creating a second artifact", async () => {
    const db = await testDb();
    const seeded = await seedArtifact(db, { title: "Report", content: "v1" });

    const result = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principalId,
      kind: "document",
      title: "Report",
      content: "v2",
      source: { origin: "agent" },
    });

    expect(result.outcome).toBe("revised");
    expect(result.artifact.id).toBe(seeded.id);
    expect(result.artifact.version).toBe(2);
    expect(result.artifact.content).toBe("v2");

    const rows = await db.select().from(artifact).where(eq(artifact.tenantId, "acme"));
    expect(rows.length).toBe(1);
  });

  test("a different kind with the same title creates a separate artifact", async () => {
    const db = await testDb();
    await seedArtifact(db, { title: "Report", kind: "document" });

    const result = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principalId,
      kind: "csv-export",
      title: "Report",
      content: "csv body",
      source: { origin: "agent" },
    });

    expect(result.outcome).toBe("created");
    const rows = await db.select().from(artifact).where(eq(artifact.title, "Report"));
    expect(rows.length).toBe(2);
  });

  test("an archived match does not get silently revived — a fresh artifact is created", async () => {
    const db = await testDb();
    const archived = await seedArtifact(db, { title: "Report" });
    await setArtifactArchived(db, archived, true);

    const result = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principalId,
      kind: "document",
      title: "Report",
      content: "fresh",
      source: { origin: "agent" },
    });

    expect(result.outcome).toBe("created");
    expect(result.artifact.id).not.toBe(archived.id);
  });

  // The race the ticket describes: two callers both see "no match" under a
  // plain read-then-write, and both create. The advisory lock this helper
  // takes must serialize them instead, so the second caller's lookup runs
  // AFTER the first caller's write is committed and finds it.
  test("concurrent calls for the same (tenant, kind, title) converge on one artifact", async () => {
    const db = await testDb();

    const [first, second] = await Promise.all([
      findOrVersionArtifact(db, {
        scope: SCOPE,
        ownerPrincipalId: SCOPE.principalId,
        kind: "document",
        title: "Report",
        content: "from first",
        source: { origin: "agent" },
      }),
      findOrVersionArtifact(db, {
        scope: SCOPE,
        ownerPrincipalId: SCOPE.principalId,
        kind: "document",
        title: "Report",
        content: "from second",
        source: { origin: "agent" },
      }),
    ]);

    expect(first.artifact.id).toBe(second.artifact.id);
    expect([first.outcome, second.outcome].sort()).toEqual(["created", "revised"]);
    expect([first.artifact.version, second.artifact.version].sort()).toEqual([1, 2]);

    const rows = await db.select().from(artifact).where(eq(artifact.tenantId, "acme"));
    expect(rows.length).toBe(1);
    const versions = await db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, first.artifact.id));
    expect(versions.length).toBe(2);
  });
});

describe("serialization", () => {
  test("a null source reads as an unknown origin", () => {
    expect(normalizeSource(null)).toEqual({ origin: "unknown" });
  });

  test("an unrecognized origin is downgraded, keeping the other keys", () => {
    expect(normalizeSource({ origin: "martian", url: "u" })).toEqual({
      origin: "unknown",
      url: "u",
    });
  });

  test("a recognized origin is preserved verbatim", () => {
    expect(normalizeSource({ origin: "agent", sessionId: "s1" })).toEqual({
      origin: "agent",
      sessionId: "s1",
    });
  });

  test("timestamps serialize as ISO strings and nullables as null", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { ownerPrincipalId: null });
    const json = serializeArtifact(row);

    expect(json.createdAt).toBe(row.createdAt.toISOString());
    expect(json.archivedAt).toBeNull();
    expect(json.ownerPrincipalId).toBeNull();
  });
});

describe("version history isolation", () => {
  test("history rows belong to exactly one artifact", async () => {
    const db = await testDb();
    const a = await seedArtifact(db, { title: "A" });
    const b = await seedArtifact(db, { title: "B" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: a.id, content: "a2" });

    const bRows = await db
      .select()
      .from(artifactVersion)
      .where(and(eq(artifactVersion.artifactId, b.id)));
    expect(bRows.length).toBe(1);
  });
});

