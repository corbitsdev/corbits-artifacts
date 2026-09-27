// A ContentStore that keeps file bytes on disk, one file per upload, referenced
// from the artifact's `source.upload.id` the way InlineContentStore references
// its bytea row.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadRefFromSource } from "../../src/content-store.js";
import type { ContentStore } from "../../src/index.js";

export function createFsContentStore(dir: string): ContentStore {
  const pathFor = (tenantId: string, id: string) => join(dir, tenantId, id);
  return {
    async put(_tx, scope, blob) {
      const id = randomUUID();
      await mkdir(join(dir, scope.tenantId), { recursive: true });
      await writeFile(pathFor(scope.tenantId, id), blob.bytes);
      return {
        content: "",
        source: {
          upload: {
            id,
            filename: blob.filename,
            mimeType: blob.mimeType,
            size: blob.bytes.byteLength,
          },
        },
      };
    },
    async get(_db, artifact) {
      const ref = uploadRefFromSource(artifact.source);
      if (ref?.id === undefined || artifact.tenantId === null) return null;
      const bytes = await readFile(pathFor(artifact.tenantId, ref.id)).catch(() => null);
      if (bytes === null) return null;
      return { filename: ref.filename, mimeType: ref.mimeType, bytes: new Uint8Array(bytes) };
    },
  };
}
