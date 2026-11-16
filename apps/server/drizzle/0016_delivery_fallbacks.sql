ALTER TABLE "deliveries" ADD COLUMN "for_people" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "fallback_to" uuid;