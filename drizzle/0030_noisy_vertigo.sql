ALTER TABLE "attachment" ADD COLUMN "thumbnail_declared_bytes" bigint;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "thumbnail_observed_bytes" bigint;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "thumbnail_ciphertext_sha256" text;