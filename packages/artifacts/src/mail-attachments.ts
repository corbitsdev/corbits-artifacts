import "./arktype.js";
import { and, eq, inArray, ne } from "drizzle-orm";
import { type } from "arktype";
import { ArtifactNotFoundError, SKILL_DRAFT_KIND } from "./artifacts.js";
import type { ArtifactDb, ArtifactTx } from "./db.js";
import { artifact, mailAttachmentRef } from "./schema.js";
import type { ResolvedPrincipal } from "./ports.js";
import { uploadRefFromSource } from "./content-store.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

// Caps are generous working bounds, not business rules: they exist so one
// request cannot bloat the table with megabyte-long names or an unbounded
// attachment list.
export const MAX_MAIL_ATTACHMENTS_PER_MAIL = 100;

/**
 * Per-attachment byte ceiling on the request body. Matches the upload path so a
 * caller cannot claim a size the store would never have accepted. When the
 * referenced artifact carries a larger durable size (already on disk), that
 * artifact truth is what is stored — this bound only gates the request field.
 */
export const MAX_MAIL_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;

/**
 * Kinds that may ride as a mail attachment. File/image are the kinds
 * `createFileArtifact` mints; everything else (document, link, web_site, …) is
 * a different resource class and is refused at create time.
 */
export const MAIL_ATTACHABLE_KINDS: ReadonlySet<string> = new Set([
  "file",
  "image",
]);

/**
 * A visible artifact whose kind is outside the attachable allowlist. Distinct
 * from `ArtifactNotFoundError` so the route can answer 400 (bad association)
 * rather than 404 (existence oracle collapse for ids the caller cannot see).
 */
export class MailAttachmentKindError extends Error {
  constructor(readonly artifactId: string, readonly kind: string) {
    super(
      `Artifact "${artifactId}" has kind "${kind}", which cannot be a mail attachment`,
    );
    this.name = "MailAttachmentKindError";
  }
}

export const MailAttachmentRefSchema = type({
  artifactId: "string > 0",
  name: "0 < string <= 512",
  type: "0 < string <= 255",
  // Integer only: the column is `integer`, and a float would silently truncate.
  // Upper bound matches the upload ceiling so the request cannot claim a size
  // the store refuses to mint.
  size: type.keywords.number.integer
    .atLeast(0)
    .atMost(MAX_MAIL_ATTACHMENT_BYTES),
});

export const SaveMailAttachmentRefsSchema = type({
  mailId: "0 < string <= 512",
  attachments: MailAttachmentRefSchema.array()
    .atLeastLength(1)
    .atMostLength(MAX_MAIL_ATTACHMENTS_PER_MAIL),
});
export type SaveMailAttachmentRefs = typeof SaveMailAttachmentRefsSchema.infer;

type AttachableArtifact = {
  id: string;
  kind: string;
  title: string;
  source: unknown;
};

/**
 * Prefer the artifact's durable upload metadata over client-supplied fields so
 * list payloads and the stored row always match the same truth a download would
 * serve. Client name/type/size fill gaps only when the artifact has no
 * `source.upload` bag (e.g. a hand-seeded file row in tests).
 */
function canonicalAttachmentMeta(
  row: AttachableArtifact,
  client: { name: string; type: string; size: number },
): { name: string; type: string; size: number } {
  const upload = uploadRefFromSource(row.source);
  const name =
    (upload?.filename && upload.filename.length > 0
      ? upload.filename
      : row.title.trim().length > 0
        ? row.title
        : client.name
    ).slice(0, 512);
  const contentType =
    upload?.mimeType && upload.mimeType.length > 0
      ? upload.mimeType.slice(0, 255)
      : client.type;
  const size =
    upload !== null &&
    typeof upload.size === "number" &&
    Number.isInteger(upload.size) &&
    upload.size >= 0
      ? upload.size
      : client.size;
  return { name, type: contentType, size };
}

/**
 * Every `artifactId` in the body must name an attachable artifact this caller
 * can actually see, or the whole request is refused.
 *
 * This table is an artifact↔message association — and an association
 * to something that is not an artifact of this tenant is not one. Unvalidated,
 * `POST /instances/:id/mail-attachments` accepted ANY string: it happily
 * recorded a reference to another tenant's artifact id and answered 201, which
 * both wrote a cross-tenant edge into the table and told the caller (by way of
 * a durable row that the matching GET reads back) that the id was worth
 * keeping. The check is the same one every detail route makes, and the answer
 * is deliberately the same 404 for an unknown id, a malformed one, a
 * skill-draft and another tenant's — this route must not become the existence
 * oracle the detail routes stopped being.
 *
 * Non-attachable kinds (document, link, …) that *are* visible are a different
 * class of failure: the id is real and tenant-owned, but the kind is outside
 * the file/image allowlist. Those throw `MailAttachmentKindError` (400).
 *
 * `mail_attachment_ref.artifact_id` is `text` with no database FK — lifecycle
 * is enforced here in the same transaction as the insert (visibility + kind +
 * write). A package-local FK onto `artifacts.artifact(id)` is feasible without
 * host-schema redesign, but deferred to avoid colliding with broader schema
 * migrations; app-level transactional checks are the current invariant.
 */
async function loadAttachableArtifacts(
  tx: ArtifactTx,
  scope: ResolvedPrincipal,
  artifactIds: string[],
): Promise<Map<string, AttachableArtifact>> {
  const wanted = [...new Set(artifactIds)];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      source: artifact.source,
    })
    .from(artifact)
    .where(
      and(
        inArray(artifact.id, wanted),
        eq(artifact.tenantId, scope.tenantId),
        ne(artifact.kind, SKILL_DRAFT_KIND),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of wanted) {
    const row = byId.get(id);
    if (row === undefined) throw new ArtifactNotFoundError(id);
    if (!MAIL_ATTACHABLE_KINDS.has(row.kind)) {
      throw new MailAttachmentKindError(id, row.kind);
    }
  }
  return byId;
}

/**
 * Record which artifacts rode along with a message. No bytes move: the file
 * already IS an artifact, and this is purely the artifact↔message association
 * a transcript replays to rehydrate its attachment chips. Idempotent on
 * (mailId, artifactId) so a retried send does not duplicate chips.
 *
 * Visibility, kind allowlist, and insert run in one transaction so a concurrent
 * delete/re-kind cannot leave a dangling ref that the pre-check would have
 * refused. Throws `ArtifactNotFoundError` if any referenced artifact is not
 * visible to `scope`, or `MailAttachmentKindError` if a visible artifact is
 * not file/image; nothing is written in either case. Stored name/type/size are
 * taken from the artifact's durable upload metadata when present.
 */
export async function saveMailAttachmentRefs(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    instanceId: string;
    body: SaveMailAttachmentRefs;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const byId = await loadAttachableArtifacts(
      tx,
      args.scope,
      args.body.attachments.map((a) => a.artifactId),
    );
    await tx
      .insert(mailAttachmentRef)
      .values(
        args.body.attachments.map((a) => {
          const row = byId.get(a.artifactId)!;
          const meta = canonicalAttachmentMeta(row, a);
          return {
            tenantId: args.scope.tenantId,
            principalId: args.scope.principalId,
            instanceId: args.instanceId,
            mailId: args.body.mailId,
            artifactId: a.artifactId,
            name: meta.name,
            mimeType: meta.type,
            size: meta.size,
          };
        }),
      )
      .onConflictDoNothing();
  });
}

export async function listMailAttachmentRefs(
  db: ArtifactDb,
  scope: ResolvedPrincipal,
  instanceId: string,
): Promise<
  { mailId: string; artifactId: string; name: string; type: string; size: number }[]
> {
  return await db
    .select({
      mailId: mailAttachmentRef.mailId,
      artifactId: mailAttachmentRef.artifactId,
      name: mailAttachmentRef.name,
      type: mailAttachmentRef.mimeType,
      size: mailAttachmentRef.size,
    })
    .from(mailAttachmentRef)
    .where(
      and(
        eq(mailAttachmentRef.instanceId, instanceId),
        eq(mailAttachmentRef.tenantId, scope.tenantId),
      ),
    );
}
