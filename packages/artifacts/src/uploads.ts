import { isAllowedMimeType } from "@intx/types";
import type { ArtifactTx } from "./db.js";
import { createArtifact } from "./artifacts.js";
import type { ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal, ContentStore } from "./ports.js";

/** Per-file ceiling. Larger inputs belong in object storage, not a bytea column. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A folder upload is unbounded; both the count and the aggregate are capped. */
export const MAX_UPLOAD_FILE_COUNT = 50;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * A file whose type the entry point's policy refuses. Thrown by
 * `createFileArtifact`, which is the authoritative gate; a route catches it and
 * answers 415.
 */
export class UnsupportedUploadTypeError extends Error {
  constructor(
    readonly filename: string,
    readonly mimeType: string,
  ) {
    super(`File "${filename}" has an unsupported type: ${mimeType || "(none)"}`);
    this.name = "UnsupportedUploadTypeError";
  }
}

/**
 * Which files an entry point accepts. Per-surface policies rather than one
 * global list: the surfaces that mint file artifacts have different trust and
 * needs, and collapsing them would silently widen the narrow ones. A policy is
 * a required argument to `createFileArtifact`, so every surface must name its
 * allowlist.
 */
export type UploadPolicy = {
  /** Whether this surface accepts a MIME type. Anything else is a 415. */
  accepts: (mimeType: string) => boolean;
  /** Extension → canonical MIME, used when the browser omits `file.type`. */
  extensions: ReadonlyMap<string, string>;
};

const acceptsOneOf = (mimeTypes: Iterable<string>) => {
  const set = new Set(mimeTypes);
  return (mimeType: string) => set.has(mimeType);
};

const DOCUMENT_EXTENSIONS = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".pdf", "application/pdf"],
  [".json", "application/json"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".doc", "application/msword"],
  [".xls", "application/vnd.ms-excel"],
  [".ppt", "application/vnd.ms-powerpoint"],
]);

const IMAGE_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * The gallery import surface: documents plus raster images.
 *
 * `image/svg+xml` is deliberately absent — an SVG can carry inline <script> and
 * would be a stored-XSS vector once served back on the app origin. Raster types
 * cover thumbnails without that risk.
 */
export const ARTIFACT_UPLOAD_POLICY: UploadPolicy = {
  accepts: acceptsOneOf([
    ...DOCUMENT_EXTENSIONS.values(),
    ...IMAGE_EXTENSIONS.values(),
  ]),
  extensions: new Map([...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS]),
};

/** The spreadsheet-ingest surface: one format, validated at the boundary so a
 *  PDF/ZIP payload is refused with a clear message rather than an opaque
 *  parser error. */
export const SPREADSHEET_UPLOAD_POLICY: UploadPolicy = {
  accepts: acceptsOneOf([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]),
  extensions: new Map([
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ]),
};

/**
 * The chat/mail attachment surface. Interchange already owns this allowlist —
 * `isAllowedMimeType` is the same list its message pipeline enforces — so this
 * policy delegates rather than keeping a second copy that could drift from it.
 */
export const PARSED_DOCUMENT_POLICY: UploadPolicy = {
  accepts: isAllowedMimeType,
  extensions: DOCUMENT_EXTENSIONS,
};

function extensionMime(filename: string, policy: UploadPolicy): string {
  const name = filename.toLowerCase();
  for (const [ext, mime] of policy.extensions) {
    if (name.endsWith(ext)) return mime;
  }
  return "";
}

/**
 * The MIME to trust for kind mapping and storage: the declared type when the
 * policy accepts it, else the extension-derived type — which the policy must
 * also accept, so an extension cannot smuggle in a type the surface refuses.
 * Empty means reject.
 */
export function effectiveUploadMime(
  file: { name: string; type: string },
  policy: UploadPolicy,
): string {
  if (policy.accepts(file.type)) return file.type;
  const fromExtension = extensionMime(file.name, policy);
  return policy.accepts(fromExtension) ? fromExtension : "";
}

/** The single MIME→kind mapping, so an image never renders inline on one path
 *  and fall back to a bare download on another. */
export function uploadArtifactKind(mimeType: string): "image" | "file" {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/** Strip characters that would break a Content-Disposition filename. */
export function downloadFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "download";
}

/**
 * A header value may only carry Latin-1, and undici throws on anything above —
 * so a single non-ASCII filename (`résumé.pdf`, `报告.pdf`) would 500 every
 * download of that artifact forever. Non-ASCII names get an ASCII placeholder
 * in `filename=` plus the real name RFC 5987-encoded in `filename*=`, which
 * every current browser prefers.
 */
export function contentDispositionHeader(
  disposition: "inline" | "attachment",
  filename: string,
): string {
  const cleaned = downloadFilename(filename);
  if (/^[\x20-\x7e]*$/.test(cleaned)) {
    return `${disposition}; filename="${cleaned}"`;
  }
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The ONE way a file becomes an artifact. Every entry point — the
 * multipart import route, a chat attachment divert, a workflow's generated
 * PDF — goes through here, so the bytes, the artifact row, and version 1 are
 * always written together in one transaction and the kind mapping is uniform.
 *
 * Callers that parse a file must parse BEFORE calling this, so a parse failure
 * leaves no orphan artifact.
 *
 * `policy` is REQUIRED and is the authoritative MIME gate. A route may (and the
 * multipart one does) pre-check a whole batch first so an unacceptable file is
 * refused before any bytes are buffered — but the check that decides whether a
 * file artifact exists happens here, at the one shared choke point, so the
 * host-owned surfaces are gated by the same allowlists as this package's own.
 */
export async function createFileArtifact(
  tx: ArtifactTx,
  contentStore: ContentStore,
  args: {
    scope: ResolvedPrincipal;
    ownerPrincipalId: string | null;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    /** The entry point's allowlist. Which surface is minting this artifact. */
    policy: UploadPolicy;
    origin?: string;
    generatedBy?: string;
  },
): Promise<ArtifactRow> {
  if (!args.policy.accepts(args.mimeType)) {
    throw new UnsupportedUploadTypeError(args.filename, args.mimeType);
  }
  const stored = await contentStore.put(tx, args.scope, {
    filename: args.filename,
    mimeType: args.mimeType,
    bytes: args.bytes,
  });
  return await createArtifact(tx, {
    scope: args.scope,
    ownerPrincipalId: args.ownerPrincipalId,
    kind: uploadArtifactKind(args.mimeType),
    title: args.filename,
    content: stored.content,
    source: {
      origin: args.origin ?? "imported",
      ...(args.generatedBy !== undefined ? { generatedBy: args.generatedBy } : {}),
      ...stored.source,
    },
  });
}
