import { grant } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import type { ArtifactTx } from "./db.js";
import type { ArtifactRow } from "./schema.js";
import type { ResolvedPrincipal } from "./ports.js";

/** Mint the creator's `write` + `archive` grants on `artifact:<id>`, inside the
 * same transaction as the artifact row. */
export async function grantCreator(
  tx: ArtifactTx,
  row: ArtifactRow,
  scope: ResolvedPrincipal,
) {
  await tx.insert(grant).values(
    (["write", "archive"] as const).map((action) => ({
      id: generateId("grant"),
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      roleId: null,
      resource: `artifact:${row.id}`,
      action,
      effect: "allow" as const,
      origin: "creator" as const,
    })),
  );
}
