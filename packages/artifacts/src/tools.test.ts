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
  windowContent,
} from "./tools.js";
import { fakeIdentity, seedArtifact, seedSkillDraft, SCOPE, testDb } from "./test-helpers.js";

const identity = fakeIdentity();
const base = { artifactId: "a1", title: "T", kind: "document", version: 1 };
const encoded = (value: unknown) => JSON.stringify(value, null, 2).length;

describe("read windowing", () => {
  test("returns short content whole, with no chunk metadata", () => {
    const result = windowContent(base, "short body");
    expect(result.content).toBe("short body");
    expect(result.contentLength).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  test("chunks content longer than the default read limit", () => {
    const content = "x".repeat(DEFAULT_READ_LIMIT + 500);
    const result = windowContent(base, content);
    expect(result.contentLength).toBe(content.length);
    expect(result.chunkStart).toBe(0);
    expect(result.continuation).toContain(`offset=${result.chunkEnd}`);
  });

  test("shrinks a chunk whose JSON encoding would blow the budget", () => {
    // Every character escapes to two, so a raw slice at the default limit
    // encodes to well over the budget unless the window shrinks.
    const content = "\n".repeat(DEFAULT_READ_LIMIT * 2);
    const result = windowContent(base, content);
    expect(encoded(result)).toBeLessThanOrEqual(SAFE_ENCODED_BUDGET);
    expect(result.chunkEnd!).toBeLessThan(DEFAULT_READ_LIMIT);
    expect(result.continuation).toBeDefined();
  });

  test("walking the continuation offsets reads the whole content exactly once", () => {
    const content = "abcdefghij".repeat(2000);
    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < 100; guard += 1) {
      const result = windowContent(base, content, offset, 3000);
      assembled += result.content;
      if (result.continuation === undefined) break;
      offset = result.chunkEnd!;
    }
    expect(assembled).toBe(content);
  });

  test("an offset past the end yields an empty final chunk", () => {
    const result = windowContent(base, "abc", 99, 10);
    expect(result.content).toBe("");
    expect(result.continuation).toBeUndefined();
  });
});

describe("artifact_read", () => {
  test("reads the latest version by default", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { title: "Doc", content: "v1" });
    await writeArtifactVersion(db, { scope: SCOPE, artifactId: row.id, content: "v2" });

    const result = await readArtifact(db, identity, { scope: SCOPE, artifactId: row.id });
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

    const result = await readArtifact(db, identity, {
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
      readArtifact(db, identity, { scope: SCOPE, artifactId: row.id, version: 7 }),
    ).rejects.toThrow(/Version 7 not found/);
  });

  test("a skill-draft is not found, not forbidden", async () => {
    const db = await testDb();
    const id = await seedSkillDraft(db, "scratch");
    await expect(
      readArtifact(db, identity, { scope: SCOPE, artifactId: id }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("a cross-tenant read fails closed when the owner is not a member there", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { tenantId: "other" });
    await expect(
      readArtifact(db, identity, {
        scope: SCOPE,
        artifactId: row.id,
        tenantId: "other",
      }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });

  test("a cross-tenant read succeeds when the owner IS a member there", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { tenantId: "other", content: "shared" });
    const result = await readArtifact(
      db,
      fakeIdentity({ ownerIsMemberOfTenant: async () => true }),
      { scope: SCOPE, artifactId: row.id, tenantId: "other" },
    );
    expect(result).toMatchObject({ content: "shared" });
  });

  test("an artifact in another tenant is invisible without naming that tenant", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { tenantId: "other" });
    await expect(
      readArtifact(db, identity, { scope: SCOPE, artifactId: row.id }),
    ).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});

describe("web_site reads", () => {
  const site = JSON.stringify({
    entry: "index.html",
    files: { "index.html": "<h1>Hi</h1>", "style.css": "body{}" },
  });

  test("an unpinned read returns the structure, not the bundle", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "web_site", content: site });

    const result = await readArtifact(db, identity, { scope: SCOPE, artifactId: row.id });
    expect(result).toMatchObject({
      summary: {
        kind: "web_site",
        entry: "index.html",
        files: [
          { path: "index.html", bytes: 11 },
          { path: "style.css", bytes: 6 },
        ],
        totalBytes: 17,
      },
    });
    expect("content" in result).toBe(false);
  });

  test("a path read returns that one file, normalizing the path", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "web_site", content: site });

    const result = await readArtifact(db, identity, {
      scope: SCOPE,
      artifactId: row.id,
      path: "/style.css",
    });
    expect(result).toMatchObject({ path: "style.css", content: "body{}" });
  });

  test("a path outside the bundle is an error, and traversal is refused", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "web_site", content: site });

    await expect(
      readArtifact(db, identity, { scope: SCOPE, artifactId: row.id, path: "nope.js" }),
    ).rejects.toThrow(/File not found in web_site artifact/);
    await expect(
      readArtifact(db, identity, {
        scope: SCOPE,
        artifactId: row.id,
        path: "../secret",
      }),
    ).rejects.toThrow(/traversal/);
  });

  test("chunked reads are refused for web_site with a pointer to the right tool", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "web_site", content: site });
    await expect(
      readArtifactChunk(db, identity, { scope: SCOPE, artifactId: row.id }),
    ).rejects.toThrow(/use artifact_read/);
  });
});

describe("artifact_read_chunk", () => {
  test("honors an explicit offset and limit", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { content: "abcdefghij" });

    const result = await readArtifactChunk(db, identity, {
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

    const result = await readArtifactChunk(db, identity, {
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
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]!.title).toBe("Quarterly deck");
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

  test("it cannot be used to mint a skill-draft", async () => {
    const db = await testDb();
    await expect(
      linkFileArtifact(db, linkArgs({ kind: "skill-draft" })),
    ).rejects.toThrow();
  });

  test("a linked artifact is readable through artifact_read", async () => {
    const db = await testDb();
    const row = await linkFileArtifact(db, linkArgs({ preview: "Slide 1: revenue" }));
    const read = await readArtifact(db, identity, { scope: SCOPE, artifactId: row.id });
    expect(read).toMatchObject({ title: "Quarterly deck", version: 1, content: "Slide 1: revenue" });
  });
});
