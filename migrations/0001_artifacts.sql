CREATE SCHEMA IF NOT EXISTS "artifacts";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts"."artifact" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
  "owner_principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "source" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "metadata" jsonb,
  "content_sha256" text,
  "archived_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "artifact_version_gte_1" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_tenant_updated_id_idx"
  ON "artifacts"."artifact" ("tenant_id", "updated_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_principal_idx"
  ON "artifacts"."artifact" ("principal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_owner_principal_idx"
  ON "artifacts"."artifact" ("owner_principal_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts"."artifact_version" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "artifact_id" text NOT NULL REFERENCES "artifacts"."artifact"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "author_id" text NOT NULL,
  "metadata" jsonb,
  "parent_version_ids" text[],
  "content_sha256" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "artifact_version_artifact_id_version" UNIQUE ("artifact_id", "version"),
  CONSTRAINT "artifact_version_version_gte_1" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts"."upload" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "principal_id" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
  "filename" text NOT NULL,
  "mime_type" text NOT NULL,
  "content" bytea NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "upload_size_gte_0" CHECK ("size" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_tenant_idx" ON "artifacts"."upload" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_principal_idx" ON "artifacts"."upload" ("principal_id");
