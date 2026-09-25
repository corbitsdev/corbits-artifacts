ALTER TABLE "artifacts"."artifact_version" ADD COLUMN IF NOT EXISTS "source" jsonb;
--> statement-breakpoint
UPDATE "artifacts"."artifact_version" AS "v"
  SET "source" = "a"."source"
  FROM "artifacts"."artifact" AS "a"
  WHERE "v"."artifact_id" = "a"."id" AND "v"."source" IS NULL AND "a"."source" IS NOT NULL;
