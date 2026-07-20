-- CreateEnum
CREATE TYPE "flag_type" AS ENUM ('boolean', 'string', 'number');

-- CreateEnum
CREATE TYPE "flag_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "environment" AS ENUM ('development', 'staging', 'production');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('flag.created', 'flag.updated', 'flag.archived', 'flag.unarchived');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "flag_type" NOT NULL,
    "default_value" JSONB NOT NULL,
    "status" "flag_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag_environments" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "environment" "environment" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "serve_value" JSONB NOT NULL,
    "rollout_percentage" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "targeting_rules" JSONB NOT NULL DEFAULT '[]',
    "variants" JSONB,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flag_environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" "audit_action" NOT NULL,
    "environment" "environment",
    "old_value" JSONB,
    "new_value" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_name_key" ON "tenants"("name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys"("tenant_id");

-- CreateIndex
CREATE INDEX "flags_tenant_id_status_idx" ON "flags"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "flags_tenant_id_key_key" ON "flags"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "flags_id_tenant_id_key" ON "flags"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "flag_environments_tenant_id_environment_idx" ON "flag_environments"("tenant_id", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "flag_environments_flag_id_environment_key" ON "flag_environments"("flag_id", "environment");

-- CreateIndex
CREATE INDEX "audit_logs_flag_id_created_at_idx" ON "audit_logs"("flag_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_environments" ADD CONSTRAINT "flag_environments_flag_id_tenant_id_fkey" FOREIGN KEY ("flag_id", "tenant_id") REFERENCES "flags"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Audit immutability: audit_logs is append-only. This trigger guards against
-- application bugs and the runtime credential; a compromised table owner is
-- out of scope (see README security section for the honest framing).
-- ============================================================
CREATE OR REPLACE FUNCTION audit_logs_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ============================================================
-- Least-privilege runtime role (cloud only). Migrations run as the migrator
-- user (table owner); the API runs as flagship_app with DML only and
-- INSERT/SELECT only on audit_logs. Locally the role does not exist and this
-- block is a no-op, keeping docker-compose single-user simple.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'flagship_app') THEN
    GRANT USAGE ON SCHEMA "public" TO flagship_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "tenants", "api_keys", "flags", "flag_environments" TO flagship_app;
    GRANT SELECT, INSERT ON "audit_logs" TO flagship_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA "public" TO flagship_app;
  END IF;
END
$$;
