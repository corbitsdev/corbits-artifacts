import "./arktype.js";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import type { ArtifactDb, ArtifactTx } from "./db.js";
import { upload } from "./schema.js";
import type {
  ResolvedPrincipal,
  ContentStore,
  FileBlob,
  StoredFile,
} from "./ports.js";

/** The upload reference an artifact's `source` carries for blob-backed content. */
export type UploadRef = {
  id?: string;
  filename: string;
  mimeType: string;
  size: number;
};

// `id` and `size` are lenient — a malformed value degrades to absent/0 rather
// than discarding an otherwise-valid reference.
const UploadRefSource = type({
  upload: type({
    "id?": "unknown",
    filename: "string",
    mimeType: "string",
    "size?": "unknown",
  }).pipe(
    (ref): UploadRef => ({
      ...(typeof ref.id === "string" && ref.id.length > 0 ? { id: ref.id } : {}),
      filename: ref.filename,
      mimeType: ref.mimeType,
      size: typeof ref.size === "number" ? ref.size : 0,
    }),
  ),
});

/** Read `source.upload` off an artifact row's opaque jsonb bag. */
export function uploadRefFromSource(source: unknown): UploadRef | null {
  const parsed = UploadRefSource(source);
  return parsed instanceof type.errors ? null : parsed.upload;
}

/**
 * Bytes in a tenant-owned `upload` row (bytea); the artifact's text `content`
 * stays empty and `source.upload.id` is the authoritative download reference.
 */
export const InlineContentStore: ContentStore = {
  async put(
    tx: ArtifactTx,
    scope: ResolvedPrincipal,
    blob: FileBlob,
  ): Promise<StoredFile> {
    const [row] = await tx
      .insert(upload)
      .values({
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        filename: blob.filename,
        mimeType: blob.mimeType,
        content: Buffer.from(blob.bytes),
        size: blob.bytes.byteLength,
      })
      .returning({ id: upload.id });
    if (!row) throw new Error("Failed to store upload");
    return {
      content: "",
      source: {
        upload: {
          id: row.id,
          filename: blob.filename,
          mimeType: blob.mimeType,
          size: blob.bytes.byteLength,
        },
      },
    };
  },

  async get(db, artifact): Promise<FileBlob | null> {
    const ref = uploadRefFromSource(artifact.source);
    if (!ref?.id || artifact.tenantId === null) return null;
    const [row] = await db
      .select()
      .from(upload)
      .where(and(eq(upload.id, ref.id), eq(upload.tenantId, artifact.tenantId)))
      .limit(1);
    if (!row) return null;
    return {
      filename: row.filename,
      mimeType: row.mimeType.length > 0 ? row.mimeType : "application/octet-stream",
      bytes: Uint8Array.from(row.content),
    };
  },
};

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * Bytes inline in the artifact's own `content` as a base64 data: URL — no
 * side-table row at all. The download path serves these through its data-URL
 * convention, which is why `get` returns null: there is nothing out-of-band.
 */
export const DataUrlContentStore: ContentStore = {
  async put(
    _tx: ArtifactTx,
    _scope: ResolvedPrincipal,
    blob: FileBlob,
  ): Promise<StoredFile> {
    return {
      content: `data:${blob.mimeType};base64,${Buffer.from(blob.bytes).toString("base64")}`,
      source: {
        upload: {
          filename: blob.filename,
          mimeType: blob.mimeType,
          size: blob.bytes.byteLength,
        },
      },
    };
  },

  async get(): Promise<null> {
    return null;
  },
};

/** Decode a base64 data: URL, or null when `content` is not one. */
export function decodeDataUrl(
  content: string,
): { mimeType: string; bytes: Uint8Array } | null {
  const match = DATA_URL.exec(content);
  if (!match) return null;
  return {
    mimeType: match[1]!,
    bytes: new Uint8Array(Buffer.from(match[2]!, "base64")),
  };
}
