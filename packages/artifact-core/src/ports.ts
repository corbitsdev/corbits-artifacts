import type { ArtifactDb, ArtifactTx } from "./db.js";

/**
 * Who an operation runs as. Held by value — no FKs into any control plane.
 *
 * This shape is IDENTICAL to `@corbits/mailbox-core`'s on purpose: a host
 * mounting both cores resolves one principal from one session, so the two must
 * agree on what "the same user" means rather than each inventing a variant.
 */
export type ResolvedPrincipal = { tenant: string; principal: string };

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

/**
 * Seam A — authorization. The host answers two VERDICTS; the core never
 * interprets directory rows to compute one itself.
 */
export type AdminAuthz = {
  /**
   * Whether scope may administer (archive/unarchive) an artifact. Called only
   * after the core has already granted the exact-owner match, so a host's
   * implementation covers whatever else it wants to allow — a tenant admin, or
   * the human member behind the agent that owns the row. Must fail closed.
   */
  canAdminister(
    scope: ResolvedPrincipal,
    row: { ownerPrincipalId: string | null },
  ): Promise<boolean>;
  /**
   * Whether scope may read another tenant's artifacts — the gate on a
   * cross-tenant `artifact_read`. Must fail closed.
   */
  canReadTenant(scope: ResolvedPrincipal, targetTenantId: string): Promise<boolean>;
};

/**
 * An authorization seam for hosts with no admin concept and no cross-tenant
 * reads: nobody is an admin, so only the exact owner can archive, and no
 * tenant may read another's artifacts. Fails closed — it degrades a feature,
 * never safety.
 *
 * Exported rather than left as an inline literal in `mount.ts` so that all of
 * this package's optional seams have a *named* default a host can reference,
 * compare against, or wrap.
 */
export const denyAllAdminAuthz: AdminAuthz = {
  canAdminister: async () => false,
  canReadTenant: async () => false,
};

/**
 * Seam C — provenance. A DISPLAY-ONLY decorator: it may add fields to the
 * serialized rows and must never affect what is returned or who may see it.
 */
export type Provenance = {
  decorate(
    tenantId: string,
    rows: { source: Record<string, unknown>; [key: string]: unknown }[],
  ): Promise<void>;
};

/** A provenance seam for hosts with no workflow runs to join against. */
export const noProvenance: Provenance = { decorate: async () => {} };
