// @corbits/artifacts — a backend-only, mountable artifact + upload store.
export { mountArtifacts } from "./mount.js";
export type { MountArtifactsOpts } from "./mount.js";

export { runArtifactMigrations, MigrationChecksumError, MigrationAdoptError } from "./migrations.js";
export type { RunArtifactMigrationsOptions } from "./migrations.js";

export { createArtifactDb } from "./db.js";
export type { ArtifactDb, ArtifactTx } from "./db.js";

export {
  ARTIFACTS_SCHEMA,
  artifact,
  artifactVersion,
  upload,
  mailAttachmentRef,
} from "./schema.js";
export type {
  ArtifactRow,
  ArtifactVersionRow,
  UploadRow,
  MailAttachmentRefRow,
} from "./schema.js";

export type {
  ResolvedPrincipal,
  ContentStore,
  FileBlob,
  StoredFile,
} from "./ports.js";

export { DataUrlContentStore, InlineContentStore } from "./content-store.js";
export type { UploadRef } from "./content-store.js";

export {
  ARTIFACT_ORIGINS,
  ArtifactNotFoundError,
  ArtifactSizeError,
  assertArtifactFieldSizes,
  createArtifact,
  DEFAULT_LIST_LIMIT,
  findArtifactByTitle,
  getArtifact,
  getArtifactVersion,
  listArtifacts,
  ListArtifactsQuery,
  listArtifactVersions,
  ListArtifactVersionsQuery,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_TITLE_LENGTH,
  MAX_LIST_LIMIT,
  serializeArtifact,
  serializeArtifactListItem,
  setArtifactArchived,
  SKILL_DRAFT_KIND,
  writeArtifactVersion,
} from "./artifacts.js";
export type {
  ArtifactListRow,
  ArtifactVersionListItem,
  CreateArtifactArgs,
  ListArtifactsFilters,
  ListArtifactVersionsFilters,
  SerializedArtifact,
  SerializedArtifactBase,
  SerializedArtifactListItem,
} from "./artifacts.js";

export {
  ARTIFACT_UPLOAD_POLICY,
  contentDispositionHeader,
  createFileArtifact,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_COUNT,
  MAX_UPLOAD_TOTAL_BYTES,
  PARSED_DOCUMENT_POLICY,
  SPREADSHEET_UPLOAD_POLICY,
  UnsupportedUploadTypeError,
} from "./uploads.js";
export type { UploadPolicy } from "./uploads.js";

export { DOWNLOADABLE_ARTIFACT_KINDS, resolveDownload } from "./download.js";
export type { Download, DownloadFailure } from "./download.js";

export {
  listMailAttachmentRefs,
  MAIL_ATTACHABLE_KINDS,
  MailAttachmentKindError,
  MAX_MAIL_ATTACHMENT_BYTES,
  MAX_MAIL_ATTACHMENTS_PER_MAIL,
  saveMailAttachmentRefs,
} from "./mail-attachments.js";

export {
  ARTIFACT_TOOL_DEFINITIONS,
  linkFileArtifact,
  readArtifact,
  readArtifactChunk,
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
  WEB_SITE_MAX_FILES,
  WEB_SITE_MAX_PATH_LENGTH,
  WEB_SITE_MAX_TOTAL_BYTES,
  WebSiteContentError,
} from "./web-site.js";
export type { WebSiteContent, WebSiteReadSummary } from "./web-site.js";
