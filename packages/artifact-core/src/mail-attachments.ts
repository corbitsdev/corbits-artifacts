import { and, eq, inArray, ne } from "drizzle-orm";
import { type } from "arktype";
import { ArtifactNotFoundError, SKILL_DRAFT_KIND } from "./artifacts.js";
import type { ArtifactDb } from "./db.js";
import { artifact, mailAttachmentRef } from "./schema.js";
import type { ResolvedPrincipal } from "./ports.js";

export const MailAttachmentRefSchema = type({
  artifactId: "string > 0",
  name: "string > 0",
  type: "string",
  size: "number >= 0",
});

export const SaveMailAttachmentRefsSchema = type({
  mailId: "string > 0",
  attachments: MailAttachmentRefSchema.array().atLeastLength(1),
});
export type SaveMailAttachmentRefs = typeof SaveMailAttachmentRefsSchema.infer;

/**
 * Every `artifactId` in the body must name an artifact this caller can actually
 * see, or the whole request is refused.
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
 * `mail_attachment_ref.artifact_id` is `text` and carries no FK — the table
 * holds its references by value like the rest of this module — so visibility is
 * checked here rather than being enforced by the column. `artifact.id` is text
 * too, so an id of any shape simply fails to match and takes the same 404.
 */
async function assertArtifactsVisible(
  db: ArtifactDb,
  scope: ResolvedPrincipal,
  artifactIds: string[],
): Promise<void> {
  const wanted = [...new Set(artifactIds)];
  const visible =
    wanted.length === 0
      ? []
      : await db
          .select({ id: artifact.id })
          .from(artifact)
          .where(
            and(
              inArray(artifact.id, wanted),
              eq(artifact.tenantId, scope.tenant),
              ne(artifact.kind, SKILL_DRAFT_KIND),
            ),
          );
  const found = new Set(visible.map((r) => r.id));
  const missing = wanted.find((id) => !found.has(id));
  if (missing !== undefined) throw new ArtifactNotFoundError(missing);
}

/**
 * Record which artifacts rode along with a message. No bytes move: the file
 * already IS an artifact, and this is purely the artifact↔message association
 * a transcript replays to rehydrate its attachment chips. Idempotent on
 * (mailId, artifactId) so a retried send does not duplicate chips.
 *
 * Throws `ArtifactNotFoundError` if any referenced artifact is not visible to
 * `scope`; nothing is written in that case.
 */
export async function saveMailAttachmentRefs(
  db: ArtifactDb,
  args: {
    scope: ResolvedPrincipal;
    instanceId: string;
    body: SaveMailAttachmentRefs;
  },
): Promise<void> {
  await assertArtifactsVisible(
    db,
    args.scope,
    args.body.attachments.map((a) => a.artifactId),
  );
  await db
    .insert(mailAttachmentRef)
    .values(
      args.body.attachments.map((a) => ({
        tenantId: args.scope.tenant,
        principalId: args.scope.principal,
        instanceId: args.instanceId,
        mailId: args.body.mailId,
        artifactId: a.artifactId,
        name: a.name,
        mimeType: a.type,
        size: a.size,
      })),
    )
    .onConflictDoNothing();
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
        eq(mailAttachmentRef.tenantId, scope.tenant),
      ),
    );
}
