import { describe, expect, test } from "bun:test";
import { artifactPreviewHeaders, resolveArtifactPreview } from "./preview.js";
import { InlineContentStore } from "./content-store.js";
import { ARTIFACT_UPLOAD_POLICY, createFileArtifact } from "./uploads.js";
import { getArtifact } from "./artifacts.js";
import { seedArtifact, SCOPE, testDb } from "./test-helpers.js";
import type { ArtifactDb } from "./db.js";

async function uploadFile(
  db: ArtifactDb,
  filename: string,
  mimeType: string,
  body: string,
) {
  const row = await db.transaction((tx) =>
    createFileArtifact(tx, InlineContentStore, {
      scope: SCOPE,
      ownerPrincipalId: SCOPE.principalId,
      filename,
      mimeType,
      bytes: new TextEncoder().encode(body),
      policy: ARTIFACT_UPLOAD_POLICY,
    }),
  );
  // Re-fetch: createFileArtifact's return may not carry the out-of-band blob.
  return (await getArtifact(db, row.id))!;
}

describe("resolveArtifactPreview", () => {
  test("resolves an uploaded text/html file's body", async () => {
    const db = await testDb();
    const row = await uploadFile(db, "page.html", "text/html", "<h1>hi</h1>");

    const result = await resolveArtifactPreview(db, InlineContentStore, row);
    expect(result).toEqual({ status: "ok", html: "<h1>hi</h1>" });
  });

  test("rejects a non-HTML upload as unsupported", async () => {
    const db = await testDb();
    const row = await uploadFile(db, "notes.txt", "text/plain", "just text");

    const result = await resolveArtifactPreview(db, InlineContentStore, row);
    expect(result).toEqual({ status: "unsupported" });
  });

  test("rejects a plain text/document artifact (not downloadable) as unsupported, not a 500", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, { kind: "document", content: "<h1>fake</h1>" });

    const result = await resolveArtifactPreview(db, InlineContentStore, row);
    expect(result).toEqual({ status: "unsupported" });
  });

  test("reports not_found when the referenced upload blob is gone", async () => {
    const db = await testDb();
    const row = await seedArtifact(db, {
      kind: "file",
      source: {
        origin: "manual",
        upload: { id: "does-not-exist", filename: "gone.html", mimeType: "text/html" },
      },
    });

    const result = await resolveArtifactPreview(db, InlineContentStore, row);
    expect(result).toEqual({ status: "not_found" });
  });
});

describe("artifactPreviewHeaders", () => {
  test("locks the response down: sandboxed, no network reach, nosniff", () => {
    const headers = artifactPreviewHeaders();
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    const csp = headers["Content-Security-Policy"]!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("X-Frame-Options");
  });
});
