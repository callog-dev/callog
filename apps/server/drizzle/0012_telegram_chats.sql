CREATE TABLE "telegram_chats" (
	"tenant_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"title" text,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_chats_tenant_id_chat_id_pk" PRIMARY KEY("tenant_id","chat_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;