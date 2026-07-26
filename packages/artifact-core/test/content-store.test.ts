import { describe, expect, test } from "bun:test";
import {
  DataUrlContentStore,
  InlineContentStore,
  decodeDataUrl,
  uploadRefFromSource,
} from "../src/content-store.js";
import { normalizeSource } from "../src/artifacts.js";
import { resolveDownload } from "../src/download.js";
import {
  ARTIFACT_UPLOAD_POLICY,
  createFileArtifact,
  uploadArtifactKind,
} from "../src/uploads.js";
import { upload } from "../src/schema.js";
import type { ContentStore } from "../src/ports.js";
import { seedArtifact, SCOPE, testDb } from "./helpers.js";
import type { ArtifactDb } from "../src/db.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PDF = new Uint8Array(Buffer.from("%PDF-1.4 body"));

async function storeFile(
  db: ArtifactDb,
  store: ContentStore,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
) {
  return await db.transaction((tx) =>
    createFileArtifact(tx, store, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principal,
      filename,
      mimeType,
      bytes,
      policy: ARTIFACT_UPLOAD_POLICY,
    }),
  );
}

// The whole point of the port: both backends must satisfy the same contract,
// so a further backend is an impl swap rather than a rewrite.
const BACKENDS: [string, ContentStore][] = [
  ["InlineContentStore", InlineContentStore],
  ["DataUrlContentStore", DataUrlContentStore],
];

for (const [name, store] of BACKENDS) {
  describe(`ContentStore parity — ${name}`, () => {
    test("a stored image round-trips through the download path byte for byte", async () => {
      const db = await testDb();
      const row = await storeFile(db, store, "logo.png", "image/png", PNG);

      expect(row.kind).toBe("image");
      expect(normalizeSource(row.source).origin).toBe("imported");

      const result = await resolveDownload(db, store, row, false);
      if ("status" in result) throw new Error(`unexpected failure: ${result.error}`);
      expect(result.mimeType).toBe("image/png");
      expect(result.filename).toBe("logo.png");
      expect(result.disposition).toBe("attachment");
      expect(new Uint8Array(result.body as Uint8Array)).toEqual(PNG);
    });

    test("a PDF is an attachment by default and inline only when asked", async () => {
      const db = await testDb();
      const row = await storeFile(db, store, "deck.pdf", "application/pdf", PDF);

      const attached = await resolveDownload(db, store, row, false);
      const inlined = await resolveDownload(db, store, row, true);
      if ("status" in attached || "status" in inlined) throw new Error("unexpected failure");
      expect(attached.disposition).toBe("attachment");
      expect(inlined.disposition).toBe("inline");
    });

    test("a non-PDF is never served inline, however hard the caller asks", async () => {
      const db = await testDb();
      const row = await storeFile(db, store, "logo.png", "image/png", PNG);
      const result = await resolveDownload(db, store, row, true);
      if ("status" in result) throw new Error("unexpected failure");
      expect(result.disposition).toBe("attachment");
    });

    test("a filename that would break Content-Disposition is sanitized", async () => {
      const db = await testDb();
      const row = await storeFile(db, store, 'ev"il\nname.png', "image/png", PNG);
      const result = await resolveDownload(db, store, row, false);
      if ("status" in result) throw new Error("unexpected failure");
      expect(result.filename).not.toContain('"');
      expect(result.filename).not.toContain("\n");
    });

    test("version 1 is written for a file artifact too", async () => {
      const db = await testDb();
      const row = await storeFile(db, store, "a.txt", "text/plain", new Uint8Array([1]));
      expect(row.version).toBe(1);
    });
  });
}

describe("InlineContentStore specifics", () => {
  test("keeps the artifact's text content empty and points at an upload row", async () => {
    const db = await testDb();
    const row = await storeFile(db, InlineContentStore, "a.png", "image/png", PNG);

    expect(row.content).toBe("");
    const ref = uploadRefFromSource(row.source);
    expect(ref?.id).toBeString();
    expect(ref?.size).toBe(PNG.byteLength);

    const uploads = await db.select().from(upload);
    expect(uploads.length).toBe(1);
    expect(uploads[0]!.tenantId).toBe("acme");
  });

  test("refuses to resolve an upload owned by another tenant", async () => {
    const db = await testDb();
    const row = await storeFile(db, InlineContentStore, "a.png", "image/png", PNG);

    const foreign = { ...row, tenantId: "other" };
    expect(await InlineContentStore.get(db, foreign)).toBeNull();
    const result = await resolveDownload(db, InlineContentStore, foreign, false);
    expect(result).toEqual({ status: 404, error: "Upload not found" });
  });

  test("a dangling upload reference is a 404, never a fall-through", async () => {
    const db = await testDb();
    const row = await storeFile(db, InlineContentStore, "a.png", "image/png", PNG);
    await db.delete(upload);

    expect(await resolveDownload(db, InlineContentStore, row, false)).toEqual({
      status: 404,
      error: "Upload not found",
    });
  });
});

describe("DataUrlContentStore specifics", () => {
  test("carries the bytes inline with no side-table row", async () => {
    const db = await testDb();
    const row = await storeFile(db, DataUrlContentStore, "a.png", "image/png", PNG);

    expect(row.content.startsWith("data:image/png;base64,")).toBe(true);
    expect((await db.select().from(upload)).length).toBe(0);
    expect(uploadRefFromSource(row.source)?.id).toBeUndefined();
  });
});

describe("download convention precedence", () => {
  test("an out-of-band blob wins over inline data-URL bytes on the same row", async () => {
    const db = await testDb();
    const inlineRow = await storeFile(
      db,
      DataUrlContentStore,
      "old.png",
      "image/png",
      new Uint8Array([9, 9, 9]),
    );
    // Re-upload the same artifact through the blob store: now BOTH conventions
    // are present on one row and the side-table row is the newer truth.
    const stored = await db.transaction((tx) =>
      InlineContentStore.put(tx, SCOPE, {
        filename: "new.png",
        mimeType: "image/png",
        bytes: PNG,
      }),
    );
    const both = {
      ...inlineRow,
      source: { ...normalizeSource(inlineRow.source), ...stored.source },
    };

    const result = await resolveDownload(db, InlineContentStore, both, false);
    if ("status" in result) throw new Error("unexpected failure");
    expect(result.filename).toBe("new.png");
    expect(new Uint8Array(result.body as Uint8Array)).toEqual(PNG);
  });

  test("a csv-export serves its text content as a .csv attachment", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      kind: "csv-export",
      title: "Keywords.csv",
      content: "a,b\n1,2\n",
    });

    const result = await resolveDownload(db, InlineContentStore, row, true);
    if ("status" in result) throw new Error("unexpected failure");
    expect(result.body).toBe("a,b\n1,2\n");
    expect(result.mimeType).toBe("text/csv; charset=utf-8");
    expect(result.filename).toBe("Keywords.csv");
    expect(result.disposition).toBe("attachment");
  });

  test("an untitled csv-export still gets a usable filename", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "csv-export", title: ".csv", content: "x" });
    const result = await resolveDownload(db, InlineContentStore, row, false);
    if ("status" in result) throw new Error("unexpected failure");
    expect(result.filename).toBe("export.csv");
  });

  test("a file artifact whose content is not a data URL is not downloadable", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "file", content: "plain text" });
    expect(await resolveDownload(db, InlineContentStore, row, false)).toEqual({
      status: 400,
      error: 'Artifact kind "file" is not downloadable',
    });
  });

  test("a plain document is not downloadable", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "document" });
    const result = await resolveDownload(db, InlineContentStore, row, false);
    expect(result).toEqual({
      status: 400,
      error: 'Artifact kind "document" is not downloadable',
    });
  });
});

describe("helpers", () => {
  test("uploadArtifactKind maps image/* to image and everything else to file", () => {
    expect(uploadArtifactKind("image/png")).toBe("image");
    expect(uploadArtifactKind("image/svg+xml")).toBe("image");
    expect(uploadArtifactKind("application/pdf")).toBe("file");
    expect(uploadArtifactKind("")).toBe("file");
  });

  test("decodeDataUrl rejects anything that is not a base64 data URL", () => {
    expect(decodeDataUrl("hello")).toBeNull();
    expect(decodeDataUrl("data:text/plain,hello")).toBeNull();
    expect(decodeDataUrl("data:text/plain;base64,aGk=")?.mimeType).toBe("text/plain");
  });

  test("uploadRefFromSource rejects a malformed or absent reference", () => {
    expect(uploadRefFromSource(null)).toBeNull();
    expect(uploadRefFromSource({})).toBeNull();
    expect(uploadRefFromSource({ upload: "nope" })).toBeNull();
    expect(uploadRefFromSource({ upload: { id: "u1" } })).toBeNull();
    expect(
      uploadRefFromSource({ upload: { filename: "a", mimeType: "text/plain" } })?.size,
    ).toBe(0);
  });
});
