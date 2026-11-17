ALTER TABLE "plaud_connections" ADD COLUMN "access_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "last_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "refresh_error" text;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "refresh_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plaud_connections" ADD COLUMN "last_alert_at" timestamp with time zone;