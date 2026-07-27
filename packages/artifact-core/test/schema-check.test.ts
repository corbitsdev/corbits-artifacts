import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createArtifactDb } from "../src/db.js";
import { runArtifactMigrations } from "../src/migrations.js";
import {
  assertExpectedColumnTypes,
  expectedColumnTypes,
  SchemaTypeMismatchError,
} from "../src/schema-check.js";
import { artifact, mailAttachmentRef } from "../src/schema.js";
import { DATABASE_URL, testDb } from "./helpers.js";

const { db } = createArtifactDb(DATABASE_URL);

/**
 * Runs `body` against a private schema on the search_path, so a deliberately
 * WRONG pre-existing table can be planted without touching the suite's own.
 */
async function inIsolatedSchema(
  name: string,
  body: (handle: ReturnType<typeof createArtifactDb>) => Promise<void>,
): Promise<void> {
  const schema = `${name}_${Date.now()}`;
  await db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
  const handle = createArtifactDb(
    `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
  );
  try {
    await body(handle);
  } finally {
    await handle.close();
    await db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
  }
}

describe("boot-time column-type assertion", () => {
  test("a schema this package created passes", async () => {
    const live = await testDb();
    await assertExpectedColumnTypes(live);
  });

  test("every declared column is covered, and as a concrete data_type", () => {
    const expected = expectedColumnTypes();
    expect(expected.length).toBeGreaterThan(0);
    expect(
      expected.filter((e) => e.table === "artifact" && e.column === "id"),
    ).toEqual([{ table: "artifact", column: "id", dataType: "text" }]);
    // Zoneless everywhere, matching Interchange. A `timestamptz` here would
    // mean the convention change never reached the database.
    for (const column of expected) {
      expect(column.dataType).not.toBe("timestamp with time zone");
    }
  });

  /**
   * The failure this whole module exists for: `CREATE TABLE IF NOT EXISTS`
   * matches on the NAME only, so a host that already owns a table called
   * `upload` gets a silent no-op, a ledger row saying 0001 applied, and every
   * later read decoding ITS columns through OUR codec.
   */
  test("a pre-existing table with a divergent column type fails the boot", async () => {
    await inIsolatedSchema("artifact_divergent", async (handle) => {
      await handle.db.execute(sql`
        CREATE TABLE "upload" (
          "id" text PRIMARY KEY,
          "tenant_id" text NOT NULL,
          "principal_id" text NOT NULL,
          "filename" text NOT NULL,
          "mime_type" text NOT NULL,
          "content" bytea NOT NULL,
          "size" bigint NOT NULL,
          "created_at" timestamptz NOT NULL DEFAULT now()
        )
      `);
      const error = await runArtifactMigrations(handle.db).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SchemaTypeMismatchError);
      const message = (error as Error).message;
      // Names the column and BOTH types, for each divergence, so the operator
      // does not have to go diffing catalogues to find out what is wrong.
      expect(message).toContain("upload.size is bigint, expected integer");
      expect(message).toContain(
        "upload.created_at is timestamp with time zone, expected timestamp without time zone",
      );
      expect(message).toContain("@corbits/artifact-core");
    });
  });

  test("a pre-existing table missing a column we depend on fails the boot", async () => {
    await inIsolatedSchema("artifact_missing", async (handle) => {
      await handle.db.execute(sql`
        CREATE TABLE "mail_attachment_ref" (
          "id" text PRIMARY KEY,
          "instance_id" text NOT NULL
        )
      `);
      const error = await runArtifactMigrations(handle.db).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SchemaTypeMismatchError);
      expect((error as Error).message).toContain(
        "mail_attachment_ref.mail_id is missing (expected text)",
      );
    });
  });

  /**
   * The assertion runs on the migration transaction, so a boot it rejects
   * leaves NO ledger row behind: the next boot re-evaluates from scratch rather
   * than skipping a migration it never really applied.
   */
  test("a rejected boot rolls back its ledger row", async () => {
    await inIsolatedSchema("artifact_rollback", async (handle) => {
      await handle.db.execute(sql`CREATE TABLE "upload" ("id" integer PRIMARY KEY)`);
      await expect(runArtifactMigrations(handle.db)).rejects.toThrow(
        SchemaTypeMismatchError,
      );
      const ledger = await handle.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_name = 'corbits_artifact_core_migrations'
          AND table_schema = current_schema()
      `);
      expect(ledger[0]?.count).toBe("0");
    });
  });
});

describe("text ids", () => {
  /**
   * `artifact.id` was `uuid` while `mail_attachment_ref.artifact_id` — a
   * reference to it, in the same file — was `text`. Joining them needed a cast,
   * and an Interchange-shaped id handed to an artifact write raised
   * `22P02 invalid input syntax for type uuid` at runtime while type-checking
   * perfectly.
   */
  test("artifact.id and mail_attachment_ref.artifact_id are the same type", () => {
    const byName = new Map(
      expectedColumnTypes().map((e) => [`${e.table}.${e.column}`, e.dataType]),
    );
    expect(byName.get("artifact.id")).toBe("text");
    expect(byName.get("mail_attachment_ref.artifact_id")).toBe("text");
  });

  test("an Interchange-shaped id writes, reads and joins with no cast", async () => {
    const live = await testDb();
    const id = "art_01J8ZQK7X9NPQW2R4T6Y8V0BCD";
    await live.insert(artifact).values({
      id,
      tenantId: "acme",
      principalId: "user-1",
      ownerPrincipalId: "user-1",
      creatorKind: "user",
      kind: "note",
      title: "hello",
      content: "hello",
      source: { origin: "manual" },
    });
    await live.insert(mailAttachmentRef).values({
      tenantId: "acme",
      principalId: "user-1",
      instanceId: "inst-1",
      mailId: "mail-1",
      artifactId: id,
      name: "hello",
      mimeType: "text/plain",
      size: 5,
    });

    const joined = await live
      .select({ title: artifact.title, name: mailAttachmentRef.name })
      .from(mailAttachmentRef)
      .innerJoin(artifact, eq(artifact.id, mailAttachmentRef.artifactId))
      .where(eq(mailAttachmentRef.mailId, "mail-1"));
    expect(joined).toEqual([{ title: "hello", name: "hello" }]);
  });

  /**
   * The old `isArtifactId` regex existed only to keep a non-UUID string from
   * reaching a `where` on a uuid column. It is gone; the same string now simply
   * matches no row, and the two must stay indistinguishable.
   */
  test("a non-UUID id that was never minted is a plain miss, not an error", async () => {
    const live = await testDb();
    const rows = await live
      .select()
      .from(artifact)
      .where(eq(artifact.id, "not-a-uuid-at-all"));
    expect(rows).toEqual([]);
  });
});
