-- Upgrading from 0.1.0, where creating needed no grant: before the ledger goes,
-- give `create` on `artifact:*` to every principal that has created an artifact
-- in its tenant. Guarded on the ledger, so it runs once and never re-grants a
-- revoked create.
DO $$
BEGIN
  IF to_regclass('"artifacts"."migrations"') IS NOT NULL THEN
    INSERT INTO "public"."grant"
      ("id", "tenant_id", "principal_id", "resource", "action", "effect", "origin")
    SELECT DISTINCT ON ("a"."tenant_id", "a"."principal_id")
      'grt_' || replace(gen_random_uuid()::text, '-', ''),
      "a"."tenant_id", "a"."principal_id", 'artifact:*', 'create', 'allow', 'system'
    FROM "artifacts"."artifact" AS "a"
    JOIN "public"."principal" AS "p" ON "p"."id" = "a"."principal_id"
    WHERE NOT EXISTS (
      SELECT 1 FROM "public"."grant" AS "g"
      WHERE "g"."tenant_id" = "a"."tenant_id"
        AND "g"."principal_id" = "a"."principal_id"
        AND "g"."resource" = 'artifact:*'
        AND "g"."action" = 'create'
    );
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "artifacts"."migrations";
