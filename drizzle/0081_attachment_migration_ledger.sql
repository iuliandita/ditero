CREATE TABLE "attachment_migration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"import_source_id" text NOT NULL,
	"source_attachment_id" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"source_metadata" jsonb NOT NULL,
	"origin_job_id" text NOT NULL,
	"origin_item_ordinal" integer NOT NULL,
	"document_digest" text NOT NULL,
	"mapping_digest" text NOT NULL,
	"plan_digest" text NOT NULL,
	"target_workspace_id" text NOT NULL,
	"target_parent_kind" "attachment_parent" NOT NULL,
	"target_parent_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"current_attempt_id" uuid,
	"committed_attempt_id" uuid,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_migration_identity" UNIQUE("owner_user_id","import_source_id","source_attachment_id"),
	CONSTRAINT "attachment_migration_owner_identity" UNIQUE("id","owner_user_id"),
	CONSTRAINT "attachment_migration_check_1" CHECK ("attachment_migration"."revision" >= 0),
	CONSTRAINT "attachment_migration_check_2" CHECK (("attachment_migration"."revision" = 0) = ("attachment_migration"."current_attempt_id" IS NULL)),
	CONSTRAINT "attachment_migration_check_3" CHECK (("attachment_migration"."committed_attempt_id" IS NULL) = ("attachment_migration"."committed_at" IS NULL)),
	CONSTRAINT "attachment_migration_check_4" CHECK ("attachment_migration"."committed_attempt_id" IS NULL OR "attachment_migration"."committed_attempt_id" = "attachment_migration"."current_attempt_id"),
	CONSTRAINT "attachment_migration_check_5" CHECK ("attachment_migration"."origin_item_ordinal" >= 0),
	CONSTRAINT "attachment_migration_check_6" CHECK ("attachment_migration"."source_fingerprint" ~ '^[0-9a-f]{64}$' AND "attachment_migration"."document_digest" ~ '^[0-9a-f]{64}$' AND "attachment_migration"."mapping_digest" ~ '^[0-9a-f]{64}$' AND "attachment_migration"."plan_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachment_migration_check_7" CHECK (jsonb_typeof("attachment_migration"."source_metadata") = 'object' AND octet_length("attachment_migration"."source_metadata"::text) <= 32768),
	CONSTRAINT "attachment_migration_check_8" CHECK (char_length("attachment_migration"."import_source_id") BETWEEN 1 AND 128 AND char_length("attachment_migration"."source_attachment_id") BETWEEN 1 AND 128 AND char_length("attachment_migration"."target_workspace_id") BETWEEN 1 AND 128 AND char_length("attachment_migration"."target_parent_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "attachment_migration_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"association_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"revision" integer NOT NULL,
	"target_attachment_id" text NOT NULL,
	"job_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"filename_ciphertext" text NOT NULL,
	"content_type_ciphertext" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"ciphertext_sha256" text NOT NULL,
	"thumbnail_declared_bytes" bigint,
	"thumbnail_ciphertext_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_migration_attempt_target" UNIQUE("target_attachment_id"),
	CONSTRAINT "attachment_migration_attempt_revision" UNIQUE("association_id","owner_user_id","revision"),
	CONSTRAINT "attachment_migration_attempt_current" UNIQUE("association_id","owner_user_id","id","revision"),
	CONSTRAINT "attachment_migration_attempt_target_id" CHECK ("attachment_migration_attempt"."target_attachment_id" ~ '^migration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "attachment_migration_attempt_check_1" CHECK ("attachment_migration_attempt"."revision" >= 1 AND "attachment_migration_attempt"."key_version" >= 1),
	CONSTRAINT "attachment_migration_attempt_check_2" CHECK ("attachment_migration_attempt"."declared_bytes" BETWEEN 1 AND 16777216),
	CONSTRAINT "attachment_migration_attempt_check_3" CHECK ("attachment_migration_attempt"."thumbnail_declared_bytes" IS NULL OR "attachment_migration_attempt"."thumbnail_declared_bytes" BETWEEN 1 AND 16777216),
	CONSTRAINT "attachment_migration_attempt_check_4" CHECK ("attachment_migration_attempt"."declared_bytes" + coalesce("attachment_migration_attempt"."thumbnail_declared_bytes",0) <= 16777216),
	CONSTRAINT "attachment_migration_attempt_check_5" CHECK (("attachment_migration_attempt"."thumbnail_declared_bytes" IS NULL) = ("attachment_migration_attempt"."thumbnail_ciphertext_sha256" IS NULL)),
	CONSTRAINT "attachment_migration_attempt_check_6" CHECK ("attachment_migration_attempt"."ciphertext_sha256" ~ '^[0-9a-f]{64}$' AND ("attachment_migration_attempt"."thumbnail_ciphertext_sha256" IS NULL OR "attachment_migration_attempt"."thumbnail_ciphertext_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "attachment_migration_attempt_check_7" CHECK (octet_length("attachment_migration_attempt"."filename_ciphertext") BETWEEN 1 AND 65536 AND octet_length("attachment_migration_attempt"."content_type_ciphertext") BETWEEN 1 AND 65536 AND octet_length("attachment_migration_attempt"."dek_wrapped") BETWEEN 1 AND 65536),
	CONSTRAINT "attachment_migration_attempt_check_8" CHECK ("attachment_migration_attempt"."job_id" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "attachment_migration" ADD CONSTRAINT "attachment_migration_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_migration_attempt" ADD CONSTRAINT "attachment_migration_attempt_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_migration_owner_idx" ON "attachment_migration" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "attachment_migration_attempt_owner_idx" ON "attachment_migration_attempt" USING btree ("owner_user_id");
--> statement-breakpoint
ALTER TABLE public.attachment_migration_attempt ADD CONSTRAINT attachment_migration_attempt_association_fk
 FOREIGN KEY(association_id, owner_user_id) REFERENCES public.attachment_migration(id,owner_user_id)
 DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.attachment_migration ADD CONSTRAINT attachment_migration_current_attempt_fk
 FOREIGN KEY(id,owner_user_id,current_attempt_id,revision)
 REFERENCES public.attachment_migration_attempt(association_id,owner_user_id,id,revision)
 DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION public.attachment_migration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a public.attachment_migration_attempt; f public.attachment;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF EXISTS(SELECT 1 FROM public."user" WHERE id=OLD.owner_user_id) THEN
   RAISE EXCEPTION 'attachment migration identity is retained' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' AND ROW(NEW.id,NEW.owner_user_id,NEW.import_source_id,NEW.source_attachment_id,NEW.source_fingerprint,NEW.source_metadata,NEW.origin_job_id,NEW.origin_item_ordinal,NEW.document_digest,NEW.mapping_digest,NEW.plan_digest,NEW.target_workspace_id,NEW.target_parent_kind,NEW.target_parent_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.import_source_id,OLD.source_attachment_id,OLD.source_fingerprint,OLD.source_metadata,OLD.origin_job_id,OLD.origin_item_ordinal,OLD.document_digest,OLD.mapping_digest,OLD.plan_digest,OLD.target_workspace_id,OLD.target_parent_kind,OLD.target_parent_id,OLD.created_at) THEN
  RAISE EXCEPTION 'attachment migration provenance is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'INSERT' AND (NEW.revision <> 0 OR NEW.current_attempt_id IS NOT NULL OR NEW.committed_attempt_id IS NOT NULL) THEN
  RAISE EXCEPTION 'attachment migration starts without an attempt' USING ERRCODE='23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF OLD.committed_attempt_id IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
   RAISE EXCEPTION 'attachment migration acknowledgment is write once' USING ERRCODE='23514';
  END IF;
  IF NEW.current_attempt_id IS DISTINCT FROM OLD.current_attempt_id THEN
   IF OLD.current_attempt_id IS NOT NULL THEN
    SELECT * INTO a FROM public.attachment_migration_attempt WHERE id=OLD.current_attempt_id AND association_id=OLD.id AND owner_user_id=OLD.owner_user_id;
    -- Service already holds this SAME old attachment before association/attempt; changed discovery must refuse.
    SELECT * INTO f FROM public.attachment WHERE id=a.target_attachment_id FOR SHARE;
    IF FOUND AND (f.state='committed' OR f.state='deleting' OR
      (f.state IN('reserved','uploading') AND (f.reservation_expires_at IS NULL OR f.reservation_expires_at > clock_timestamp()))) THEN
     RAISE EXCEPTION 'attachment migration current attempt requires recovery or retirement' USING ERRCODE='23514';
    END IF;
   END IF;
   IF NEW.revision <> OLD.revision + 1 OR NEW.committed_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'attachment migration revision must advance by one' USING ERRCODE='23514';
   END IF;
  ELSIF NEW.revision <> OLD.revision THEN
   RAISE EXCEPTION 'attachment migration revision requires a new attempt' USING ERRCODE='23514';
  END IF;
  IF OLD.committed_attempt_id IS NULL AND NEW.committed_attempt_id IS NOT NULL THEN
   SELECT * INTO a FROM public.attachment_migration_attempt
    WHERE id=NEW.current_attempt_id AND association_id=NEW.id AND owner_user_id=NEW.owner_user_id AND revision=NEW.revision;
   IF NOT FOUND THEN RAISE EXCEPTION 'attachment migration attempt is missing' USING ERRCODE='23514'; END IF;
   -- Ordinary finalizer already holds this SAME current attachment, then association/attempt.
   -- Never invoke this guard to acquire a different attachment downstream; no late owner lock.
   SELECT * INTO f FROM public.attachment WHERE id=a.target_attachment_id FOR SHARE;
   IF NOT FOUND OR f.state <> 'committed' OR f.deleted_at IS NOT NULL OR f.committed_at IS DISTINCT FROM NEW.committed_at
    OR f.uploaded_by <> NEW.owner_user_id OR f.workspace_id <> NEW.target_workspace_id
    OR f.parent_kind <> NEW.target_parent_kind OR f.parent_id <> NEW.target_parent_id
    OR f.key_version <> a.key_version OR f.filename_ciphertext <> a.filename_ciphertext
    OR f.content_type_ciphertext <> a.content_type_ciphertext OR f.dek_wrapped <> a.dek_wrapped
    OR f.declared_bytes <> a.declared_bytes OR f.observed_bytes IS DISTINCT FROM a.declared_bytes
    OR f.ciphertext_sha256 IS DISTINCT FROM a.ciphertext_sha256
    OR f.thumbnail_declared_bytes IS DISTINCT FROM a.thumbnail_declared_bytes
    OR f.thumbnail_observed_bytes IS DISTINCT FROM a.thumbnail_declared_bytes
    OR f.thumbnail_ciphertext_sha256 IS DISTINCT FROM a.thumbnail_ciphertext_sha256 THEN
    RAISE EXCEPTION 'attachment migration acknowledgment requires exact committed attachment' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER attachment_migration_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attachment_migration
 FOR EACH ROW EXECUTE FUNCTION public.attachment_migration_guard();
--> statement-breakpoint
CREATE FUNCTION public.attachment_migration_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p public.attachment_migration;
BEGIN
 IF TG_OP = 'DELETE' AND NOT EXISTS(SELECT 1 FROM public."user" WHERE id=OLD.owner_user_id) THEN RETURN OLD; END IF;
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'attachment migration attempts are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.attachment_migration WHERE id=NEW.association_id AND owner_user_id=NEW.owner_user_id;
 IF NOT FOUND OR p.committed_attempt_id IS NOT NULL OR NEW.revision <> p.revision+1 THEN
  RAISE EXCEPTION 'attachment migration attempt requires next revision' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER attachment_migration_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.attachment_migration_attempt
 FOR EACH ROW EXECUTE FUNCTION public.attachment_migration_attempt_guard();
--> statement-breakpoint
ALTER TABLE public.attachment_migration ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.attachment_migration FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attachment_migration_owner_select ON public.attachment_migration FOR SELECT USING(owner_user_id=current_setting('ditero.user_id',true));
--> statement-breakpoint
ALTER TABLE public.attachment_migration_attempt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.attachment_migration_attempt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attachment_migration_attempt_owner_select ON public.attachment_migration_attempt FOR SELECT USING(owner_user_id=current_setting('ditero.user_id',true));
--> statement-breakpoint
CREATE POLICY attachment_migration_owner_insert ON public.attachment_migration FOR INSERT WITH CHECK(
 owner_user_id=current_setting('ditero.user_id',true) AND EXISTS(
 SELECT 1 FROM public.import_job j JOIN public.import_run r ON r.job_id=j.id AND r.owner_user_id=j.owner_user_id
 WHERE j.id=origin_job_id AND j.owner_user_id=attachment_migration.owner_user_id
 AND j.source_id=import_source_id AND j.document_digest=attachment_migration.document_digest
 AND j.mapping_digest=attachment_migration.mapping_digest AND j.plan_digest=attachment_migration.plan_digest
 AND j.apply_supported AND j.planner_version IN(2,3,4,5) AND r.state='completed'));
--> statement-breakpoint
CREATE POLICY attachment_migration_owner_update ON public.attachment_migration FOR UPDATE
 USING(owner_user_id=current_setting('ditero.user_id',true))
 WITH CHECK(owner_user_id=current_setting('ditero.user_id',true));
--> statement-breakpoint
CREATE POLICY attachment_migration_attempt_owner_insert ON public.attachment_migration_attempt FOR INSERT WITH CHECK(
 owner_user_id=current_setting('ditero.user_id',true) AND EXISTS(
 SELECT 1 FROM public.attachment_migration p WHERE p.id=association_id AND p.owner_user_id=attachment_migration_attempt.owner_user_id));
--> statement-breakpoint
CREATE FUNCTION public.attachment_migration_attempt_adopted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public."user" WHERE id=NEW.owner_user_id) THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.attachment_migration p WHERE p.id=NEW.association_id
  AND p.owner_user_id=NEW.owner_user_id AND p.current_attempt_id=NEW.id AND p.revision=NEW.revision) THEN
  RAISE EXCEPTION 'new attachment migration attempt must become current in its transaction' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attachment_migration_attempt_adopted AFTER INSERT ON public.attachment_migration_attempt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.attachment_migration_attempt_adopted();
--> statement-breakpoint
CREATE POLICY attachment_migration_insert_scope ON public.attachment_migration AS RESTRICTIVE FOR INSERT WITH CHECK(
 EXISTS(SELECT 1 FROM public.workspace w JOIN public.membership m ON m.workspace_id=w.id
 WHERE w.id=target_workspace_id AND m.user_id=attachment_migration.owner_user_id AND m.role IN('owner','admin','member')));
--> statement-breakpoint
CREATE POLICY attachment_migration_attempt_insert_scope ON public.attachment_migration_attempt AS RESTRICTIVE FOR INSERT WITH CHECK(
 EXISTS(SELECT 1 FROM public.attachment_migration p JOIN public.import_job j ON j.source_id=p.import_source_id
 JOIN public.import_run r ON r.job_id=j.id AND r.owner_user_id=j.owner_user_id
 JOIN public.membership m ON m.workspace_id=p.target_workspace_id
 WHERE p.id=association_id AND p.owner_user_id=attachment_migration_attempt.owner_user_id
 AND j.id=attachment_migration_attempt.job_id AND j.owner_user_id=p.owner_user_id AND j.apply_supported
 AND j.planner_version IN(2,3,4,5) AND r.state='completed'
 AND m.user_id=p.owner_user_id AND m.role IN('owner','admin','member')));

--> statement-breakpoint
CREATE FUNCTION public.attachment_migration_commit_latch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
 IF left(NEW.id,10) <> 'migration_' THEN RETURN NEW; END IF;
 -- The committing statement already holds this attachment before the ledger.
 UPDATE public.attachment_migration p
 SET committed_attempt_id=a.id, committed_at=NEW.committed_at
 FROM public.attachment_migration_attempt a
 WHERE a.target_attachment_id=NEW.id AND a.owner_user_id=NEW.uploaded_by
  AND a.owner_user_id=current_setting('ditero.user_id',true)
  AND p.id=a.association_id AND p.owner_user_id=a.owner_user_id
  AND p.current_attempt_id=a.id AND p.revision=a.revision;
 GET DIAGNOSTICS affected = ROW_COUNT;
 IF affected <> 1 THEN
  RAISE EXCEPTION 'migration attachment commit requires its current owned attempt' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER attachment_migration_commit_latch AFTER UPDATE OF state ON public.attachment
 FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state='committed')
 EXECUTE FUNCTION public.attachment_migration_commit_latch();
