DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"artifacts"."artifact"'::regclass AND conname = 'artifact_version_gte_1') THEN
    ALTER TABLE "artifacts"."artifact" ADD CONSTRAINT "artifact_version_gte_1" CHECK ("version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"artifacts"."artifact_version"'::regclass AND conname = 'artifact_version_version_gte_1') THEN
    ALTER TABLE "artifacts"."artifact_version" ADD CONSTRAINT "artifact_version_version_gte_1" CHECK ("version" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"artifacts"."upload"'::regclass AND conname = 'upload_size_gte_0') THEN
    ALTER TABLE "artifacts"."upload" ADD CONSTRAINT "upload_size_gte_0" CHECK ("size" >= 0);
  END IF;
END
$guard$;
--> statement-breakpoint
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'artifacts' AND table_name = 'artifact'
      AND column_name = 'tenant_id' AND is_nullable = 'YES'
  ) THEN
    IF EXISTS (SELECT 1 FROM "artifacts"."artifact" WHERE "tenant_id" IS NULL) THEN
      RAISE WARNING 'artifacts.artifact has rows with a null tenant_id; left tenant_id nullable. Assign a tenant or delete those rows, then re-run migrations.';
    ELSE
      ALTER TABLE "artifacts"."artifact" ALTER COLUMN "tenant_id" SET NOT NULL;
    END IF;
  END IF;
END
$guard$;
