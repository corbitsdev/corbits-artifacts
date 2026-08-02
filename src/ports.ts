import type { ArtifactDb, ArtifactTx } from "./db.js";

/**
 * Who an operation runs as. Both ids name rows in Interchange's control plane
 * (`tenant`, `principal`), which the artifact tables reference with hard FKs.
 *
 * This shape is IDENTICAL to `@corbits/mailbox-core`'s on purpose: a host
 * mounting both cores resolves one principal from one session, so the two must
 * agree on what "the same user" means rather than each inventing a variant.
 */
export type ResolvedPrincipal = { tenantId: string; principalId: string };

/** Bytes plus the metadata needed to serve them back. */
export type FileBlob = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

/** The two artifact-row fields a stored file determines. */
export type StoredFile = {
  content: string;
  source: Record<string, unknown>;
};

/**
 * Where an artifact's file bytes live. Two impls ship here — `InlineContentStore`
 * (bytea side-table, referenced by `source.upload.id`) and
 * `DataUrlContentStore` (bytes inline in `content` as a data: URL) — and both
 * pass the same suite, so a further backend is a third impl rather than a
 * rewrite.
 */
export type ContentStore = {
  /** Persist bytes inside the caller's transaction and return the row fields. */
  put(
    tx: ArtifactTx,
    scope: ResolvedPrincipal,
    blob: FileBlob,
  ): Promise<StoredFile>;
  /**
   * Resolve an artifact's OUT-OF-BAND bytes, or null when this store keeps the
   * content in the row itself. Tenant-scoped: a reference that resolves to
   * another tenant's bytes must return null.
   */
  get(
    db: ArtifactDb,
    artifact: { tenantId: string | null; source: unknown },
  ): Promise<FileBlob | null>;
};
