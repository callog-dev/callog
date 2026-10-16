CREATE TABLE "telegram_connections" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"bot_username" text NOT NULL,
	"bot_token_encrypted" text NOT NULL,
	"last_update_id" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;