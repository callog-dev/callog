ALTER TABLE "unmapped_recipients" ADD COLUMN "reason" text;--> statement-breakpoint
-- people.yaml is gone; its links were explicit statements by config owners,
-- the closest remaining source is an admin's manual link.
UPDATE "identities" SET "source" = 'admin' WHERE "source" = 'config_file';
