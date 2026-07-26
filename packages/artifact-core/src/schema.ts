import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * Surrogate key for this package's OWN rows: a database-generated uuid stored
 * as `text`.
 *
 * `text`, not `uuid`, for three reasons that all point the same way:
 *
 *  - Interchange's own schema is `text("id").primaryKey()` on every table, and
 *    these packages are mounted onto Interchange hosts. An id that crosses the
 *    seam should not change type at the seam.
 *  - `mail_attachment_ref.artifact_id` in this very file is `text` (it holds
 *    its reference by value, like every other cross-table id here). While
 *    `artifact.id` was `uuid` the two could not be joined without a cast, and
 *    any Interchange-shaped id handed to an artifact write raised
 *    `22P02 invalid input syntax for type uuid` at RUNTIME rather than failing
 *    to type-check.
 *  - Mounting onto a database that already owns a table of this name does not
 *    require rewriting its existing text ids.
 *
 * Deliberately NOT an Interchange-style prefixed id from `generateId`: that
 * function mints ids only for the kinds Interchange owns, and minting lookalike
 * prefixes here would shadow that scheme with a second, unowned one.
 */
const surrogateId = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

/**
 * A first-class output of any workflow, agent, or human import. `kind` is
 * free-form text validated at the application edge, not a pg enum, so kinds
 * grow without a migration.
 *
 * Zero control-plane foreign keys: `tenantId` / `principalId` /
 * `ownerPrincipalId` are held BY VALUE so this table drops onto a host schema
 * it knows nothing about. The only FKs are `parentId` (self-ref) and
 * `artifact_version.artifactId`.
 *
 * `parentId` is kept deliberately: it has no live writer today, but it
 * is the declared nesting seam, it costs one nullable column and one cascade,
 * and dropping it would be a breaking schema change the moment a host nests.
 */
export const artifact = pgTable(
  "artifact",
  {
    id: surrogateId(),
    tenantId: text("tenant_id"),
    principalId: text("principal_id"),
    ownerPrincipalId: text("owner_principal_id"),
    parentId: text("parent_id").references((): AnyPgColumn => artifact.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: jsonb("source"),
    version: integer("version").notNull().default(1),
    /** Soft-archive: null = visible, a timestamp = hidden from discovery. */
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // (tenant, updatedAt, id) — the id is the list's tie-break column and must
    // be IN the index, or the keyset cursor's row-value comparison falls out of
    // the Index Cond into a Filter and drags a sort node behind it.
    index("artifact_tenant_updated_id_idx").on(t.tenantId, t.updatedAt, t.id),
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
export const artifactVersion = pgTable(
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("artifact_version_artifact_id_version").on(t.artifactId, t.version),
  ],
);

/**
 * Blob side-table backing `InlineContentStore`. Referenced from an artifact's
 * `source.upload.id`; it is never a standalone resource. There is no standalone
 * `POST /uploads` — every upload mints its artifact eagerly.
 */
export const upload = pgTable("upload", {
  id: surrogateId(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  content: bytea("content").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * An artifact↔message association. Carries no bytes: the file already IS an
 * artifact, and this only records which artifacts rode along with which
 * message so a transcript can rehydrate its attachment chips.
 */
export const mailAttachmentRef = pgTable(
  "mail_attachment_ref",
  {
    id: surrogateId(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    instanceId: text("instance_id").notNull(),
    mailId: text("mail_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    unique("mail_attachment_ref_mail_id_artifact_id").on(
      t.mailId,
      t.artifactId,
    ),
    index("mail_attachment_ref_instance_idx").on(t.instanceId),
  ],
);

export type ArtifactRow = typeof artifact.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersion.$inferSelect;
export type UploadRow = typeof upload.$inferSelect;
export type MailAttachmentRefRow = typeof mailAttachmentRef.$inferSelect;
