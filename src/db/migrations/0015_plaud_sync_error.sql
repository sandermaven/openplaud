ALTER TABLE "plaud_connections" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "sync_error_at" timestamp with time zone;
