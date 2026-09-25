CREATE TYPE "public"."import_history_collection" AS ENUM('comments', 'templates', 'completionEvents');--> statement-breakpoint
CREATE TABLE "import_history_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"collection" "import_history_collection" NOT NULL,
	"target_parent_id" text NOT NULL,
	"source_namespace" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"source_row_id_sha256" text NOT NULL,
	"target_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_history_ledger_source" UNIQUE("collection","target_parent_id","source_namespace","source_row_id_sha256"),
	CONSTRAINT "import_history_ledger_target" UNIQUE("collection","target_id"),
	CONSTRAINT "import_history_ledger_id_nonempty" CHECK (length("import_history_ledger"."id") > 0),
	CONSTRAINT "import_history_ledger_parent_nonempty" CHECK (length("import_history_ledger"."target_parent_id") > 0),
	CONSTRAINT "import_history_ledger_target_nonempty" CHECK (length("import_history_ledger"."target_id") > 0),
	CONSTRAINT "import_history_ledger_source_hash" CHECK ("import_history_ledger"."source_row_id_sha256" = encode(sha256(convert_to("import_history_ledger"."source_row_id", 'UTF8')), 'hex')),
	CONSTRAINT "import_history_ledger_digest" CHECK ("import_history_ledger"."content_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "import_history_redaction" (
	"ledger_id" text PRIMARY KEY NOT NULL,
	"redacted_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_history_redaction" ADD CONSTRAINT "import_history_redaction_ledger_id_import_history_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."import_history_ledger"("id") ON DELETE no action ON UPDATE no action;