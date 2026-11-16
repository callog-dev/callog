CREATE TABLE "hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"route_id" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "hooks_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "hooks_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;