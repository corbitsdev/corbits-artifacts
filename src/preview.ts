import type { ArtifactDb } from "./db.js";
import { resolveDownload } from "./download.js";
import type { ArtifactRow } from "./schema.js";
import type { ContentStore } from "./ports.js";

/** Bare MIME type, stripped of any `; charset=...` parameter. */
function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Outcome of resolving an artifact's sandboxed HTML preview. */
export type ArtifactPreviewResult =
  | { readonly status: "ok"; readonly html: string }
  | { readonly status: "not_found" }
  | { readonly status: "unsupported" };

/**
 * Resolve a single artifact's previewable HTML body, or an honest failure —
 * `resolveDownload`'s own 404 maps to `not_found`; anything whose resolved
 * MIME type is not exactly `text/html` (including a 400 "not downloadable"
 * kind) maps to `unsupported`. Only `text/html` is ever previewable: this is
 * a sandboxed render of a self-contained page, not a generic content viewer.
 */
export async function resolveArtifactPreview(
  db: ArtifactDb,
  contentStore: ContentStore,
  row: ArtifactRow,
): Promise<ArtifactPreviewResult> {
  const download = await resolveDownload(db, contentStore, row, false);
  if ("status" in download) {
    return { status: download.status === 404 ? "not_found" : "unsupported" };
  }
  if (baseMimeType(download.mimeType) !== "text/html") {
    return { status: "unsupported" };
  }
  const html =
    typeof download.body === "string"
      ? download.body
      : new TextDecoder().decode(download.body);
  return { status: "ok", html };
}

/**
 * CSP + headers for serving a sandboxed HTML preview: the page renders
 * visually but can reach nothing on the host's own origin.
 *  - `sandbox allow-scripts` (mirrored by the embedding iframe's own
 *    `sandbox` attribute): scripts may run, but the document sits in an
 *    opaque unique origin — no cookies, no storage, no same-origin fetches,
 *    no top-level navigation, no popups.
 *  - `default-src 'none'`: nothing loads unless a more specific directive
 *    below allows it — no network reach to the host API or anywhere else.
 *  - `style-src 'unsafe-inline'`: inline `<style>`/`style=` renders, since a
 *    single-file page has no external stylesheet to fetch.
 *  - `img-src data:`: inline data-URL images render; no external image
 *    fetches.
 *  - `script-src 'unsafe-inline'`: inline `<script>` runs, matching the
 *    `sandbox allow-scripts` directive above; no external script fetches.
 * `X-Frame-Options` is deliberately never set — the page must stay
 * frameable by the host's own canvas iframe.
 */
export function artifactPreviewHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  };
}
