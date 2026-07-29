import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Every table this package owns lives in its own `artifacts` Postgres schema.
 * The host database is shared — Interchange's control plane (`principal`,
 * `tenant`, …) stays in `public`, and this package can never collide with (or
 * silently adopt) a host table of the same name.
 *
 * This package is COUPLED to Interchange by design: `tenant_id` and the
 * principal columns carry real foreign keys into the host control plane, so an
 * artifact can never name a tenant or principal that does not exist. It mounts
 * on Interchange-shaped hosts only.
 */
export const ARTIFACTS_SCHEMA = "artifacts";
export const artifactsSchema = pgSchema(ARTIFACTS_SCHEMA);

// Interchange's control-plane tables, declared just far enough to carry the
// foreign keys — the id column only, in the host's `public` schema. NOT
// exported: these are FK targets, not tables this package owns or reads.
const hostTenant = pgTable("tenant", { id: text("id").primaryKey() });
const hostPrincipal = pgTable("principal", { id: text("id").primaryKey() });

/** Deleting a tenant takes its artifacts with it. */
const tenantRef = (column: string) =>
  text(column).references(() => hostTenant.id, { onDelete: "cascade" });
/** A removed principal must not vaporize its artifacts. */
const principalRef = (column: string) =>
  text(column).references(() => hostPrincipal.id, { onDelete: "set null" });

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// Surrogate key: a database-generated uuid stored as `text`, matching
// Interchange's text-id convention so ids never change type at the seam.
const surrogateId = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

/**
 * A first-class output of any workflow, agent, or human import. `kind` is
 * free-form text validated at the application edge, not a pg enum, so kinds
 * grow without a migration.
 *
 * `tenantId` is required and, with the principal columns, is a hard foreign
 * key into the host's control plane: this package binds to Interchange, and
 * the database refuses an artifact whose tenant or principal does not exist.
 * Whether a principal *belongs* to that tenant is host-owned — see the data
 * model note in ARCHITECTURE.md — so there is no multi-table trigger here.
 */
export const artifact = artifactsSchema.table(
  "artifact",
  {
    id: surrogateId(),
    tenantId: tenantRef("tenant_id").notNull(),
    principalId: principalRef("principal_id"),
    ownerPrincipalId: principalRef("owner_principal_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: jsonb("source"),
    version: integer("version").notNull().default(1),
    /** Soft-archive: null = visible, a timestamp = hidden from discovery. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The id tie-break must be IN the keyset index (see migrations.ts).
    index("artifact_tenant_updated_id_idx").on(t.tenantId, t.updatedAt, t.id),
    index("artifact_principal_idx").on(t.principalId),
    index("artifact_owner_principal_idx").on(t.ownerPrincipalId),
    check("artifact_version_gte_1", sql`${t.version} >= 1`),
  ],
);

/**
 * Append-only history. Every create and every revision writes a row, so a
 * version-pinned read always resolves — including version 1, which is written
 * eagerly with the artifact.
 *
 * The (artifactId, version) unique constraint is the second half of the
 * version-bump double-guard: `SELECT ... FOR UPDATE` serializes writers, and
 * this index makes a racing writer that somehow computed the same next version
 * fail loudly rather than corrupt history.
 */
export const artifactVersion = artifactsSchema.table(
  "artifact_version",
  {
    id: surrogateId(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    authorId: text("author_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("artifact_version_artifact_id_version").on(t.artifactId, t.version),
    check("artifact_version_version_gte_1", sql`${t.version} >= 1`),
  ],
);

/**
 * Blob side-table backing `InlineContentStore`. Referenced from an artifact's
 * `source.upload.id`; it is never a standalone resource. There is no standalone
 * `POST /uploads` — every upload mints its artifact eagerly.
 */
export const upload = artifactsSchema.table(
  "upload",
  {
    id: surrogateId(),
    tenantId: tenantRef("tenant_id").notNull(),
    // Nullable so a removed principal SET NULLs instead of blocking the delete.
    principalId: principalRef("principal_id"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    content: bytea("content").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("upload_tenant_idx").on(t.tenantId),
    index("upload_principal_idx").on(t.principalId),
    check("upload_size_gte_0", sql`${t.size} >= 0`),
  ],
);

/**
 * An artifact↔message association. Carries no bytes: the file already IS an
 * artifact, and this only records which artifacts rode along with which
 * message so a transcript can rehydrate its attachment chips.
 */
export const mailAttachmentRef = artifactsSchema.table(
  "mail_attachment_ref",
  {
    id: surrogateId(),
    tenantId: tenantRef("tenant_id").notNull(),
    // Nullable so a removed principal SET NULLs instead of blocking the delete.
    principalId: principalRef("principal_id"),
    instanceId: text("instance_id").notNull(),
    mailId: text("mail_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mail_attachment_ref_mail_id_artifact_id").on(
      t.mailId,
      t.artifactId,
    ),
    index("mail_attachment_ref_instance_idx").on(t.instanceId),
    index("mail_attachment_ref_tenant_idx").on(t.tenantId),
    index("mail_attachment_ref_principal_idx").on(t.principalId),
    check("mail_attachment_ref_size_gte_0", sql`${t.size} >= 0`),
  ],
);

export type ArtifactRow = typeof artifact.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersion.$inferSelect;
export type UploadRow = typeof upload.$inferSelect;
export type MailAttachmentRefRow = typeof mailAttachmentRef.$inferSelect;
