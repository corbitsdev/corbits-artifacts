import type { ArtifactDb } from "./db.js";
import { decodeDataUrl, uploadRefFromSource } from "./content-store.js";
import type { ArtifactRow } from "./schema.js";
import type { ContentStore } from "./ports.js";
import { downloadFilename } from "./uploads.js";

/** Kinds whose text `content` IS a downloadable file body. */
export const DOWNLOADABLE_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  "csv-export",
]);

export type Download = {
  body: Uint8Array | string;
  mimeType: string;
  filename: string;
  disposition: "inline" | "attachment";
};

export type DownloadFailure = { status: 404 | 400; error: string };

function csvFilename(title: string): string {
  const cleaned = title.replace(/[\r\n"\\]/g, "").replace(/\.csv$/i, "").trim();
  return `${cleaned.length > 0 ? cleaned : "export"}.csv`;
}

/**
 * User-supplied bytes are served as `attachment` so they never execute inline
 * on the app origin. The one exception is a PDF explicitly requested inline: it
 * renders in the browser's built-in viewer, not an origin-execution context, so
 * an embedded deck preview can iframe it. `nosniff` (set by the caller) pins the
 * declared type either way.
 */
function disposition(mimeType: string, wantsInline: boolean) {
  return wantsInline && mimeType === "application/pdf" ? "inline" : "attachment";
}

/**
 * The single download path, resolving the three storage conventions in
 * precedence order:
 *
 *  1. out-of-band blob (`ContentStore.get`, e.g. `source.upload.id` → bytea)
 *  2. inline data: URL in `content`, for `file` / `image` kinds
 *  3. plain text body, for the downloadable text kinds (csv-export)
 *
 * Blob beats data-URL deliberately: an artifact carrying both has been
 * re-uploaded, and the side-table row is the newer truth. A blob reference that
 * does not resolve is a 404, never a silent fall-through to stale inline bytes.
 */
export async function resolveDownload(
  db: ArtifactDb,
  contentStore: ContentStore,
  row: ArtifactRow,
  wantsInline: boolean,
): Promise<Download | DownloadFailure> {
  const blob = await contentStore.get(db, row);
  if (blob) {
    return {
      body: blob.bytes,
      mimeType: blob.mimeType,
      filename: downloadFilename(blob.filename),
      disposition: disposition(blob.mimeType, wantsInline),
    };
  }
  if (uploadRefFromSource(row.source)?.id !== undefined) {
    return { status: 404, error: "Upload not found" };
  }

  if (row.kind === "file" || row.kind === "image") {
    const inline = decodeDataUrl(row.content);
    if (inline) {
      return {
        body: inline.bytes,
        mimeType: inline.mimeType,
        filename: downloadFilename(row.title),
        disposition: disposition(inline.mimeType, wantsInline),
      };
    }
  }

  if (!DOWNLOADABLE_ARTIFACT_KINDS.has(row.kind)) {
    return {
      status: 400,
      error: `Artifact kind "${row.kind}" is not downloadable`,
    };
  }

  return {
    body: row.content,
    mimeType: "text/csv; charset=utf-8",
    filename: csvFilename(row.title),
    disposition: "attachment",
  };
}
