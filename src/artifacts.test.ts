import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  ArtifactSizeError,
  ArtifactValidationError,
  createArtifact,
  findArtifactByTitle,
  findOrVersionArtifact,
  getArtifact,
  getArtifactVersion,
  listArtifactVersions,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_TITLE_LENGTH,
  normalizeSource,
  serializeArtifact,
  setArtifactArchived,
  sha256Hex,
  writeArtifactVersion,
} from "./artifacts.js";
import { artifact, artifactVersion } from "./schema.js";
import { seedArtifact, SCOPE, testDb } from "./test-helpers.js";

describe("create", () => {
  test("writes version 1 eagerly, so a pinned read of v1 resolves immediately", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Brief", content: "first" });

    expect(row.version).toBe(1);
    const pinned = await getArtifactVersion(db, row.id, 1);
    expect(pinned).toEqual({
      title: "Brief",
      content: "first",
      version: 1,
      metadata: null,
      parentVersionIds: null,
      contentSha256: sha256Hex("first"),
      source: { origin: "manual" },
    });
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
});

describe("versioning", () => {

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

  test("refuses a revision that changes nothing", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await expect(
      writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id }),
    ).rejects.toThrow(/content, title, and\/or metadata/);
  });
});

describe("archive", () => {

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

  test("never returns an archived artifact", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Hidden" });
    await setArtifactArchived(db, row, true);

    expect(await findArtifactByTitle(db, "acme", "Hidden")).toBeNull();
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

  // Beyond the two-caller case above: each blocked caller is meant to drain
  // sequentially off the lock and re-read after the previous commit, no
  // matter how many are queued up. Five is enough to prove that generalizes
  // without slowing CI down.
  test("five concurrent calls for the same (tenant, kind, title) converge on one artifact", async () => {
    const db = await testDb();
    const callerCount = 5;

    const results = await Promise.all(
      Array.from({ length: callerCount }, (_, i) =>
        findOrVersionArtifact(db, {
          scope: SCOPE,
          ownerPrincipalId: SCOPE.principalId,
          kind: "document",
          title: "Report",
          content: `from caller ${i}`,
          source: { origin: "agent" },
        }),
      ),
    );

    const artifactIds = new Set(results.map((r) => r.artifact.id));
    expect(artifactIds.size).toBe(1);
    expect(results.filter((r) => r.outcome === "created").length).toBe(1);
    expect(results.filter((r) => r.outcome === "revised").length).toBe(callerCount - 1);
    expect(results.map((r) => r.artifact.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);

    const rows = await db.select().from(artifact).where(eq(artifact.tenantId, "acme"));
    expect(rows.length).toBe(1);
    const versions = await db
      .select()
      .from(artifactVersion)
      .where(eq(artifactVersion.artifactId, results[0]!.artifact.id));
    expect(versions.length).toBe(callerCount);
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

describe("version metadata and lineage", () => {
  test("round-trips metadata and parentVersionIds on create, mirrored onto the artifact row", async () => {
    const db = await testDb();
    const row = await db.transaction((tx) =>
      createArtifact(tx, {
        scope: SCOPE,
        ownerPrincipalId: null,
        kind: "document",
        title: "Brief",
        content: "v1",
        source: { origin: "manual" },
        metadata: { tag: "draft" },
        parentVersionIds: ["ancestor-1"],
      }),
    );

    expect(row.metadata).toEqual({ tag: "draft" });

    const pinned = await getArtifactVersion(db, row.id, 1);
    expect(pinned?.metadata).toEqual({ tag: "draft" });
    expect(pinned?.parentVersionIds).toEqual(["ancestor-1"]);

    const detail = serializeArtifact(row);
    expect(detail.metadata).toEqual({ tag: "draft" });
  });

  test("writeArtifactVersion carries metadata forward when omitted, but never carries parentVersionIds forward", async () => {
    const db = await testDb();
    const row = await db.transaction((tx) =>
      createArtifact(tx, {
        scope: SCOPE,
        ownerPrincipalId: null,
        kind: "document",
        title: "Brief",
        content: "v1",
        source: { origin: "manual" },
        metadata: { tag: "draft" },
        parentVersionIds: ["ancestor-1"],
      }),
    );

    const second = await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      content: "v2",
    });
    expect(second.metadata).toEqual({ tag: "draft" });

    const v2 = await getArtifactVersion(db, row.id, 2);
    expect(v2?.metadata).toEqual({ tag: "draft" });
    expect(v2?.parentVersionIds).toBeNull();

    const third = await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      content: "v3",
      metadata: { tag: "final" },
      parentVersionIds: ["v1-id", "v2-id"],
    });
    expect(third.metadata).toEqual({ tag: "final" });
    const v3 = await getArtifactVersion(db, row.id, 3);
    expect(v3?.parentVersionIds).toEqual(["v1-id", "v2-id"]);
  });

  test("findOrVersionArtifact passes metadata and parentVersionIds through both outcomes", async () => {
    const db = await testDb();
    const created = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: null,
      kind: "document",
      title: "Report",
      content: "v1",
      source: { origin: "workflow" },
      metadata: { origin: "pipeline" },
    });
    expect(created.outcome).toBe("created");
    expect(created.artifact.metadata).toEqual({ origin: "pipeline" });

    const revised = await findOrVersionArtifact(db, {
      scope: SCOPE,
      ownerPrincipalId: null,
      kind: "document",
      title: "Report",
      content: "v2",
      source: { origin: "workflow" },
      parentVersionIds: [created.artifact.id],
    });
    expect(revised.outcome).toBe("revised");
    expect(revised.artifact.metadata).toEqual({ origin: "pipeline" });
    const revisedVersion = await getArtifactVersion(
      db,
      revised.artifact.id,
      revised.artifact.version,
    );
    expect(revisedVersion?.parentVersionIds).toEqual([created.artifact.id]);
  });

  test("listArtifactVersions returns metadata and parentVersionIds per version", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Draft", content: "v1" });
    await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      content: "v2",
      metadata: { step: 2 },
      parentVersionIds: [row.id],
    });

    const history = await listArtifactVersions(db, row.id);
    const v2 = history.versions.find((v) => v.version === 2);
    expect(v2?.metadata).toEqual({ step: 2 });
    expect(v2?.parentVersionIds).toEqual([row.id]);
    const v1 = history.versions.find((v) => v.version === 1);
    expect(v1?.metadata).toBeNull();
    expect(v1?.parentVersionIds).toBeNull();
  });

  test("rejects a non-object metadata and a non-string-array parentVersionIds", async () => {
    const db = await testDb();
    await expect(
      db.transaction((tx) =>
        createArtifact(tx, {
          scope: SCOPE,
          ownerPrincipalId: null,
          kind: "document",
          title: "x",
          content: "y",
          source: { origin: "manual" },
          metadata: ["not", "an", "object"] as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toBeInstanceOf(ArtifactValidationError);

    await expect(
      writeArtifactVersion(db, {
        scope: SCOPE,
        artifactId: (await seedArtifact(db)).id,
        content: "z",
        parentVersionIds: [1, 2] as unknown as string[],
      }),
    ).rejects.toBeInstanceOf(ArtifactValidationError);
  });
});

describe("content digest", () => {
  test("create computes sha256 over the UTF-8 bytes of content", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Brief", content: "first" });

    expect(row.contentSha256).toBe(sha256Hex("first"));
    const pinned = await getArtifactVersion(db, row.id, 1);
    expect(pinned?.contentSha256).toBe(sha256Hex("first"));
  });

  test("changes when content is revised", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "v1" });

    const second = await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      content: "v2",
    });
    expect(second.contentSha256).toBe(sha256Hex("v2"));
    expect(second.contentSha256).not.toBe(sha256Hex("v1"));

    const v2 = await getArtifactVersion(db, row.id, 2);
    expect(v2?.contentSha256).toBe(sha256Hex("v2"));
  });

  test("carries the prior digest forward unchanged on a metadata/title-only revise", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "unchanged" });
    const originalDigest = sha256Hex("unchanged");
    expect(row.contentSha256).toBe(originalDigest);

    const revised = await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      title: "New Title",
      metadata: { tag: "reviewed" },
    });
    expect(revised.contentSha256).toBe(originalDigest);

    const v2 = await getArtifactVersion(db, row.id, 2);
    expect(v2?.contentSha256).toBe(originalDigest);
  });

  test("a legacy row with a null digest serializes as null", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "legacy" });
    // Simulate a row written before digests existed — never backfilled.
    await db.execute(
      sql`UPDATE "artifacts"."artifact" SET "content_sha256" = NULL WHERE "id" = ${row.id}`,
    );
    await db.execute(
      sql`UPDATE "artifacts"."artifact_version" SET "content_sha256" = NULL WHERE "artifact_id" = ${row.id}`,
    );

    const fetched = await getArtifact(db, row.id);
    expect(fetched).not.toBeNull();
    expect(serializeArtifact(fetched!).contentSha256).toBeNull();

    const pinned = await getArtifactVersion(db, row.id, 1);
    expect(pinned?.contentSha256).toBeNull();
  });
});

