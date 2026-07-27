// @corbits/artifact-core — a backend-only, mountable artifact + upload store.
export { mountArtifacts, IMPORTABLE_ARTIFACT_KINDS } from "./mount.js";
export type { MountArtifactsOpts } from "./mount.js";

export { runArtifactMigrations, MigrationChecksumError } from "./migrations.js";

export {
  assertExpectedColumnTypes,
  expectedColumnTypes,
  SchemaTypeMismatchError,
} from "./schema-check.js";

export { createArtifactDb } from "./db.js";
export type { ArtifactDb, ArtifactTx } from "./db.js";

export { artifact, artifactVersion, upload, mailAttachmentRef } from "./schema.js";
export type {
  ArtifactRow,
  ArtifactVersionRow,
  UploadRow,
  MailAttachmentRefRow,
} from "./schema.js";

export { denyAllAdminAuthz, noProvenance } from "./ports.js";
export type {
  AdminAuthz,
  ResolvedPrincipal,
  ContentStore,
  FileBlob,
  Provenance,
  StoredFile,
} from "./ports.js";

export {
  DataUrlContentStore,
  InlineContentStore,
  decodeDataUrl,
  uploadRefFromSource,
} from "./content-store.js";
export type { UploadRef } from "./content-store.js";

export {
  ARTIFACT_ORIGINS,
  ArtifactFilterError,
  ArtifactNotFoundError,
  createArtifact,
  DEFAULT_LIST_LIMIT,
  enrich,
  findArtifactByTitle,
  getArtifact,
  getArtifactVersion,
  listArtifacts,
  listArtifactVersions,
  MAX_LIST_LIMIT,
  normalizeSource,
  serializeArtifact,
  setArtifactArchived,
  SKILL_DRAFT_KIND,
  writeArtifactVersion,
} from "./artifacts.js";
export type {
  CreateArtifactArgs,
  ListArtifactsFilters,
  SerializedArtifact,
} from "./artifacts.js";

export {
  ARTIFACT_UPLOAD_POLICY,
  createFileArtifact,
  downloadFilename,
  effectiveUploadMime,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
  PARSED_DOCUMENT_POLICY,
  SPREADSHEET_UPLOAD_POLICY,
  UnsupportedUploadTypeError,
  uploadArtifactKind,
} from "./uploads.js";
export type { UploadPolicy } from "./uploads.js";

export { DOWNLOADABLE_ARTIFACT_KINDS, resolveDownload } from "./download.js";
export type { Download, DownloadFailure } from "./download.js";

export {
  listMailAttachmentRefs,
  MailAttachmentRefSchema,
  saveMailAttachmentRefs,
  SaveMailAttachmentRefsSchema,
} from "./mail-attachments.js";
export type { SaveMailAttachmentRefs } from "./mail-attachments.js";

export {
  ARTIFACT_TOOL_DEFINITIONS,
  DEFAULT_READ_LIMIT,
  linkFileArtifact,
  readArtifact,
  readArtifactChunk,
  SAFE_ENCODED_BUDGET,
  windowContent,
} from "./tools.js";
export type { ArtifactReadResult, ArtifactToolDefinition } from "./tools.js";

export {
  normalizeWebSiteContent,
  normalizeWebSitePath,
  parseWebSiteContentJson,
  serializeWebSiteContent,
  summarizeWebSiteContent,
  WEB_SITE_KIND,
  WebSiteContentError,
  WebSiteContentSchema,
} from "./web-site.js";
export type { WebSiteContent, WebSiteReadSummary } from "./web-site.js";
