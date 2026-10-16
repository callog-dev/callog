CREATE TABLE "person_preferences" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dm_channel" text DEFAULT 'slack' NOT NULL,
	"muted_routes" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_preferences" ADD CONSTRAINT "person_preferences_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_preferences" ADD CONSTRAINT "person_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;