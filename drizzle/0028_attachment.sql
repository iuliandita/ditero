CREATE TYPE "public"."attachment_parent" AS ENUM('task', 'comment', 'list');--> statement-breakpoint
CREATE TYPE "public"."attachment_state" AS ENUM('reserved', 'uploading', 'committed', 'aborted', 'deleting');--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_kind" "attachment_parent" NOT NULL,
	"parent_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"state" "attachment_state" DEFAULT 'reserved' NOT NULL,
	"filename_ciphertext" text NOT NULL,
	"content_type_ciphertext" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"observed_bytes" bigint,
	"ciphertext_sha256" text,
	"storage_key" text NOT NULL,
	"thumbnail_storage_key" text,
	"uploaded_by" text NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_parent" ON "attachment" USING btree ("parent_kind","parent_id");--> statement-breakpoint
CREATE INDEX "attachment_sweep" ON "attachment" USING btree ("state","reservation_expires_at");