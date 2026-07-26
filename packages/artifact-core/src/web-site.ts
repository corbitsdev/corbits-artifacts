import { type } from "arktype";

/** A multi-file static site stored as one artifact whose content is JSON. */
export const WEB_SITE_KIND = "web_site";

export const WEB_SITE_MAX_FILES = 64;
export const WEB_SITE_MAX_TOTAL_BYTES = 4_500_000;

export const WebSiteContentSchema = type({
  "entry?": "string",
  files: "Record<string, string>",
});
export type WebSiteContent = typeof WebSiteContentSchema.infer;

export class WebSiteContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSiteContentError";
  }
}

/** Strip leading slashes, normalize separators, and reject traversal. */
export function normalizeWebSitePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) {
    throw new WebSiteContentError("file path must not be empty");
  }
  for (const segment of normalized.split("/")) {
    if (segment === "..") {
      throw new WebSiteContentError(`invalid path (traversal): ${path}`);
    }
    if (segment.length === 0) {
      throw new WebSiteContentError(`invalid path (empty segment): ${path}`);
    }
  }
  return normalized;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** Normalize every path, default the entry, and enforce the size ceilings. */
export function normalizeWebSiteContent(
  content: WebSiteContent,
): Required<WebSiteContent> {
  const files: Record<string, string> = {};
  let total = 0;
  for (const [rawPath, fileContent] of Object.entries(content.files)) {
    const path = normalizeWebSitePath(rawPath);
    if (path in files) {
      throw new WebSiteContentError(
        `duplicate path after normalization: ${path}`,
      );
    }
    files[path] = fileContent;
    total += byteLength(fileContent);
  }

  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw new WebSiteContentError("web_site must include at least one file");
  }
  if (paths.length > WEB_SITE_MAX_FILES) {
    throw new WebSiteContentError(
      `web_site exceeds max file count (${WEB_SITE_MAX_FILES})`,
    );
  }
  if (total > WEB_SITE_MAX_TOTAL_BYTES) {
    throw new WebSiteContentError(
      `web_site total size exceeds ${WEB_SITE_MAX_TOTAL_BYTES} bytes`,
    );
  }

  const entry = normalizeWebSitePath(content.entry ?? "index.html");
  if (!(entry in files)) {
    throw new WebSiteContentError(`entry file "${entry}" is not present in files`);
  }
  return { entry, files };
}

export function parseWebSiteContentJson(raw: string): Required<WebSiteContent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WebSiteContentError("web_site content must be valid JSON");
  }
  const result = WebSiteContentSchema(parsed);
  if (result instanceof type.errors) {
    throw new WebSiteContentError(`web_site content invalid: ${result.summary}`);
  }
  return normalizeWebSiteContent(result);
}

export function serializeWebSiteContent(content: WebSiteContent): string {
  return JSON.stringify(normalizeWebSiteContent(content));
}

export type WebSiteReadSummary = {
  kind: typeof WEB_SITE_KIND;
  entry: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
};

/** What an agent gets from an unpinned `web_site` read: shape, not payload. */
export function summarizeWebSiteContent(rawJson: string): WebSiteReadSummary {
  const content = parseWebSiteContentJson(rawJson);
  const files = Object.entries(content.files)
    .map(([path, text]) => ({ path, bytes: byteLength(text) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    kind: WEB_SITE_KIND,
    entry: content.entry,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}
