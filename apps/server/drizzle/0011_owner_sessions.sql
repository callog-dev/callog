ALTER TABLE "web_sessions" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_github_login" text;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD COLUMN "github_login" text;