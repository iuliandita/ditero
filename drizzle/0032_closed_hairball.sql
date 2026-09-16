CREATE TABLE "import_item" (
	"job_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"collection" text NOT NULL,
	"source_id" text NOT NULL,
	"source_key" text NOT NULL,
	"item_digest" text NOT NULL,
	"target_id" text,
	"disposition" text NOT NULL,
	"payload" jsonb NOT NULL,
	"codes" jsonb NOT NULL,
	CONSTRAINT "import_item_job_id_ordinal_pk" PRIMARY KEY("job_id","ordinal"),
	CONSTRAINT "import_item_disposition" CHECK ("import_item"."disposition" in ('ensure', 'ignored', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"document_digest" text NOT NULL,
	"mapping_digest" text NOT NULL,
	"plan_digest" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_txid" bigint DEFAULT txid_current() NOT NULL,
	"payload_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_job_payload_bytes" CHECK ("import_job"."payload_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_source" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"format" text NOT NULL,
	"schema_version" integer NOT NULL,
	"source_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_source_label_length" CHECK (char_length("import_source"."label") between 1 and 100)
);
--> statement-breakpoint
ALTER TABLE "import_item" ADD CONSTRAINT "import_item_job_id_import_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_source_id_import_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."import_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_source" ADD CONSTRAINT "import_source_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_job_owner_idx" ON "import_job" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "import_job_source_idx" ON "import_job" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "import_source_owner_idx" ON "import_source" USING btree ("owner_user_id");