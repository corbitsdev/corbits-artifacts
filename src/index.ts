// @corbits/artifacts — a backend-only, mountable artifact + upload store.
export { createArtifactRoutes } from "./mount.js";
export type { CreateArtifactRoutesDeps } from "./mount.js";

export { createWorkflowArtifactRoutes } from "./workflow-mount.js";
export type {
  AgentTokenAuth,
  AgentTokenIdentity,
  CreatedWorkflowArtifact,
  CreateWorkflowArtifactRoutesDeps,
  ResolvedWorkflowRunScope,
  WorkflowArtifactEnv,
  WorkflowRunResolver,
} from "./workflow-mount.js";

export {
  ArtifactCountsIncompleteError,
  countArtifactsBySegments,
  MAX_COUNT_PAGES,
} from "./counts.js";
export type { ArtifactCounts, ArtifactCountSegments } from "./counts.js";

export { artifactPreviewHeaders, resolveArtifactPreview } from "./preview.js";
export type { ArtifactPreviewResult } from "./preview.js";

export { runArtifactMigrations } from "./migrations.js";

export { createArtifactDb } from "./db.js";
export type { ArtifactDb, ArtifactTx } from "./db.js";

export { ARTIFACTS_SCHEMA } from "./schema.js";
export type { ArtifactRow, ArtifactVersionRow, UploadRow } from "./schema.js";

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
  findOrVersionArtifact,
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
  writeArtifactVersion,
} from "./artifacts.js";
export type {
  ArtifactListRow,
  ArtifactVersionListItem,
  CreateArtifactArgs,
  FindOrVersionArtifactArgs,
  FindOrVersionArtifactResult,
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
  reviseFileArtifact,
  SPREADSHEET_UPLOAD_POLICY,
  UnsupportedUploadTypeError,
} from "./uploads.js";
export type { UploadPolicy } from "./uploads.js";

export { DOWNLOADABLE_ARTIFACT_KINDS, resolveDownload } from "./download.js";
export type { Download, DownloadFailure } from "./download.js";

export {
  ARTIFACT_TOOL_DEFINITIONS,
  linkFileArtifact,
  readArtifact,
  readArtifactChunk,
} from "./tools.js";
export type { ArtifactReadResult, ArtifactToolDefinition } from "./tools.js";
