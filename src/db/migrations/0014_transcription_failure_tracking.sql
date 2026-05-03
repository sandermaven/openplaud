ALTER TABLE "recordings" ADD COLUMN "last_transcription_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "transcription_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "transcription_error" text;
