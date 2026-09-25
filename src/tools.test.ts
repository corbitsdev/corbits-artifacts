import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  ArtifactNotFoundError,
  listArtifactVersions,
  writeArtifactVersion,
} from "./artifacts.js";
import {
  ARTIFACT_TOOL_DEFINITIONS,
  DEFAULT_READ_LIMIT,
  linkFileArtifact,
  readArtifact,
  readArtifactChunk,
  SAFE_ENCODED_BUDGET,
} from "./tools.js";
import { seedArtifact, SCOPE, testDb } from "./test-helpers.js";

async function read(content: string, offset?: number, limit?: number) {
  const db = await testDb();
  const row = await seedArtifact(db, { content });
  if (offset === undefined) return await readArtifact(db, { scope: SCOPE, artifactId: row.id });
  return await readArtifactChunk(db, {
    scope: SCOPE,
    artifactId: row.id,
    offset,
    ...(limit !== undefined ? { limit } : {}),
  });
}

const encoded = (value: unknown) => JSON.stringify(value, null, 2).length;

describe("read windowing", () => {
  test("returns short content whole, with no chunk metadata", async () => {
    const result = await read("short body");
    expect(result.content).toBe("short body");
    expect(result.contentLength).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  test("chunks content longer than the default read limit", async () => {
    const content = "x".repeat(DEFAULT_READ_LIMIT + 500);
    const result = await read(content);
    expect(result.contentLength).toBe(content.length);
    expect(result.chunkStart).toBe(0);
    expect(result.continuation).toContain(`offset=${result.chunkEnd}`);
  });

  test("shrinks a chunk whose JSON encoding would blow the budget", async () => {
    // Every character escapes to two, so a raw slice at the default limit
    // encodes to well over the budget unless the window shrinks.
    const content = "\n".repeat(DEFAULT_READ_LIMIT * 2);
    const result = await read(content);
    expect(encoded(result)).toBeLessThanOrEqual(SAFE_ENCODED_BUDGET);
    expect(result.chunkEnd!).toBeLessThan(DEFAULT_READ_LIMIT);
    expect(result.continuation).toBeDefined();
  });

  test("walking the continuation offsets reads the whole content exactly once", async () => {
    const content = "abcdefghij".repeat(2000);
    const db = await testDb();
    const row = await seedArtifact(db, { content });
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < 100; guard += 1) {
      const result = await read(content, offset, 3000);
      assembled += result.content;
      if (result.continuation === undefined) break;
      offset = result.chunkEnd!;
    }
    expect(assembled).toBe(content);
  });

  test("an offset past the end yields an empty final chunk", async () => {
    const result = await read("abc", 99, 10);
    expect(result.content).toBe("");
    expect(result.continuation).toBeUndefined();
  });
});

describe("artifact_read", () => {
  test("reads the latest version by default", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Doc", content: "v1" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "v2" });

    const result = await readArtifact(db, { scope: SCOPE, artifactId: row.id });
    expect(result).toMatchObject({ version: 2, content: "v2" });
  });

  test("reads a pinned past version, with that version's title", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Old title", content: "v1" });
    await writeArtifactVersion(db, {
      scope: SCOPE,
      artifactId: row.id,
      title: "New title",
      content: "v2",
    });

    const result = await readArtifact(db, {
      scope: SCOPE,
      artifactId: row.id,
      version: 1,
    });
    expect(result).toMatchObject({ version: 1, content: "v1", title: "Old title" });
  });

  test("a missing version is an error naming the version", async () => {
    const db = await testDb();
    const row = await seedArtifact(db);
    await expect(
      readArtifact(db, { scope: SCOPE, artifactId: row.id, version: 7 }),
    ).rejects.toThrow(/Version 7 not found/);
  });

  test("an artifact in another tenant is not found", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { tenantId: "other" });
    await expect(
      readArtifact(db, { scope: SCOPE, artifactId: row.id }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});

describe("artifact_read_chunk", () => {
  test("honors an explicit offset and limit", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "abcdefghij" });

    const result = await readArtifactChunk(db, {
      scope: SCOPE,
      artifactId: row.id,
      offset: 3,
      limit: 4,
    });
    expect(result.content).toBe("defg");
    expect(result.chunkStart).toBe(3);
    expect(result.chunkEnd).toBe(7);
    expect(result.continuation).toBeDefined();
  });

  test("reads a pinned version's content in chunks", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "original" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "revised" });

    const result = await readArtifactChunk(db, {
      scope: SCOPE,
      artifactId: row.id,
      version: 1,
      limit: 4,
    });
    expect(result.content).toBe("orig");
  });
});

describe("tool definitions", () => {
  test("every definition is uniquely named and declares its required inputs", () => {
    const names = ARTIFACT_TOOL_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of ARTIFACT_TOOL_DEFINITIONS) {
      for (const required of definition.inputSchema.required) {
        expect(Object.keys(definition.inputSchema.properties)).toContain(required);
      }
    }
  });

  test("artifact_create and artifact_write both declare an optional metadata object", () => {
    for (const name of ["artifact_create", "artifact_write"]) {
      const definition = ARTIFACT_TOOL_DEFINITIONS.find((d) => d.name === name)!;
      expect(definition.inputSchema.properties["metadata"]).toEqual({
        type: "object",
        description:
          "Optional application metadata stored with the version, e.g. which project and stage this belongs to.",
      });
      expect(definition.inputSchema.required).not.toContain("metadata");
    }
  });

  test("only the mutating tools declare a write side effect", () => {
    const writes = ARTIFACT_TOOL_DEFINITIONS.filter((d) => d.sideEffect === "write").map(
      (d) => d.name,
    );
    expect(writes.sort()).toEqual(["artifact_create", "artifact_link_file", "artifact_write"]);
  });

  // A descriptor with no behavior behind it is worse than a missing tool: the
  // host registers it, the model calls it, and the call cannot be served. This
  // pins every declared name to the package export a host would bind it to.
  test("every declared tool has an implementing export in the package", async () => {
    const pkg = (await import("../src/index.js")) as Record<string, unknown>;
    const BINDINGS: Record<string, string> = {
      artifact_create: "createArtifact",
      artifact_link_file: "linkFileArtifact",
      artifact_read: "readArtifact",
      artifact_read_chunk: "readArtifactChunk",
      artifact_write: "writeArtifactVersion",
      artifact_list: "listArtifacts",
      artifact_find_by_title: "findArtifactByTitle",
    };
    for (const definition of ARTIFACT_TOOL_DEFINITIONS) {
      const exportName = BINDINGS[definition.name];
      expect({ tool: definition.name, bound: exportName }).toEqual({
        tool: definition.name,
        bound: expect.any(String) as unknown as string,
      });
      expect(typeof pkg[exportName!]).toBe("function");
    }
  });
});

describe("artifact_link_file", () => {
  const linkArgs = (over: Record<string, unknown> = {}) => ({
    scope: SCOPE,
    ownerPrincipalId: SCOPE.principalId,
    title: "Quarterly deck",
    kind: "file",
    path: "out/deck.pdf",
    ...over,
  });

  test("mints the artifact and its version 1, recording the workspace path", async () => {
    const db = await testDb();
    const row = await linkFileArtifact(db, linkArgs({ preview: "Slide 1: revenue" }));

    expect(row.version).toBe(1);
    expect(row.kind).toBe("file");
    expect(row.content).toBe("Slide 1: revenue");
    expect(row.source).toEqual({ origin: "agent", workspace: { path: "out/deck.pdf" } });

    const versions = await listArtifactVersions(db, row.id);
    expect(versions.versions.map((v) => v.version)).toEqual([1]);
    expect(versions.versions[0]!.title).toBe("Quarterly deck");
  });

  test("no bytes move: nothing is written to the blob side-table", async () => {
    const db = await testDb();
    await linkFileArtifact(db, linkArgs());
    const uploads = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM "artifacts"."upload"`);
    expect(uploads[0]!.n).toBe("0");
  });

  test("an omitted preview links the file with empty content, not a fake body", async () => {
    const db = await testDb();
    const row = await linkFileArtifact(db, linkArgs());
    expect(row.content).toBe("");
  });

  test("a blank path is refused, and no artifact is left behind", async () => {
    const db = await testDb();
    await expect(linkFileArtifact(db, linkArgs({ path: "   " }))).rejects.toThrow(
      "requires a workspace path",
    );
    const rows = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM "artifacts"."artifact"`);
    expect(rows[0]!.n).toBe("0");
  });


  test("a linked artifact is readable through artifact_read", async () => {
    const db = await testDb();
    const row = await linkFileArtifact(db, linkArgs({ preview: "Slide 1: revenue" }));
    const read = await readArtifact(db, { scope: SCOPE, artifactId: row.id });
    expect(read).toMatchObject({ title: "Quarterly deck", version: 1, content: "Slide 1: revenue" });
  });
});
