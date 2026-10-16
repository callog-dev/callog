ALTER TABLE "tenants" ADD COLUMN "github_org_id" bigint;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_github_org_id_unique" UNIQUE("github_org_id");