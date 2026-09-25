import { schema as intx } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { createArtifact } from "../src/artifacts.js";
import type { ArtifactDb } from "../src/db.js";
import type { ArtifactRow } from "../src/schema.js";
import type { HostDb } from "./helpers.js";

type Tenant = typeof intx.tenant.$inferSelect;
type Principal = typeof intx.principal.$inferSelect;

export type Actor = { tenant: Tenant; principal: Principal };

/** A tenant with one active user principal, allowed to create artifacts. */
export async function seedActor(db: HostDb, slug: string): Promise<Actor> {
  const [tenant] = await db
    .insert(intx.tenant)
    .values({
      id: generateId("tenant"),
      name: slug,
      slug,
      domain: `${slug}.example`,
    })
    .returning();
  const [principal] = await db
    .insert(intx.principal)
    .values({
      id: generateId("principal"),
      tenantId: tenant!.id,
      kind: "user",
      refId: `user-${slug}`,
      status: "active",
    })
    .returning();
  await grant(
    db,
    { tenant: tenant!, principal: principal! },
    "artifact:*",
    "create",
  );
  return { tenant: tenant!, principal: principal! };
}

export async function grant(
  db: HostDb,
  actor: Actor,
  resource: string,
  action: string,
): Promise<void> {
  await db.insert(intx.grant).values({
    id: generateId("grant"),
    tenantId: actor.tenant.id,
    principalId: actor.principal.id,
    roleId: null,
    resource,
    action,
    effect: "allow",
    origin: "system",
    conditions: null,
  });
}

export const SCOPE = { tenantId: "acme", principalId: "user-1" };

export async function seedArtifact(
  db: ArtifactDb,
  overrides: Partial<{
    kind: string;
    title: string;
    content: string;
    source: Record<string, unknown>;
    ownerPrincipalId: string | null;
    tenantId: string;
  }> = {},
): Promise<ArtifactRow> {
  const scope = {
    tenantId: overrides.tenantId ?? SCOPE.tenantId,
    principalId: SCOPE.principalId,
  };
  return await db.transaction((tx) =>
    createArtifact(tx, {
      scope,
      ownerPrincipalId:
        overrides.ownerPrincipalId === undefined
          ? scope.principalId
          : overrides.ownerPrincipalId,
      kind: overrides.kind ?? "document",
      title: overrides.title ?? "Untitled",
      content: overrides.content ?? "body",
      source: overrides.source ?? { origin: "manual" },
    }),
  );
}
