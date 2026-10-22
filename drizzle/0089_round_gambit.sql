CREATE TABLE "focus_interval_clock" (
	"user_id" text NOT NULL,
	"interval_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_interval_clock_user_id_interval_id_pk" PRIMARY KEY("user_id","interval_id")
);
--> statement-breakpoint
ALTER TABLE "focus_interval_clock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "focus_interval_clock" ADD CONSTRAINT "focus_interval_clock_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "focus_interval_clock_expiry" ON "focus_interval_clock" USING btree ("started_at");--> statement-breakpoint
-- Old starts may overlap; do not promote them to exclusive timing evidence.
DELETE FROM "focus_interval_start";
--> statement-breakpoint
ALTER TABLE "focus_interval_start" DROP COLUMN "started_at";--> statement-breakpoint
CREATE POLICY "focus_interval_clock_owner_update" ON "focus_interval_clock" AS PERMISSIVE FOR UPDATE TO public USING ("focus_interval_clock"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("focus_interval_clock"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "focus_interval_clock_owner_select" ON "focus_interval_clock" AS PERMISSIVE FOR SELECT TO public USING ("focus_interval_clock"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "focus_interval_clock_owner_insert" ON "focus_interval_clock" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("focus_interval_clock"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "focus_interval_clock_owner_delete" ON "focus_interval_clock" AS PERMISSIVE FOR DELETE TO public USING ("focus_interval_clock"."user_id" = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE FUNCTION public.prune_focus_intervals() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 WITH expired AS MATERIALIZED (
  SELECT user_id, interval_id FROM public.focus_interval_clock
  WHERE started_at < now() - interval '14 days'
  ORDER BY started_at LIMIT 500 FOR UPDATE SKIP LOCKED
 ), removed_ids AS (
  DELETE FROM public.focus_interval_start s USING expired e
  WHERE s.user_id=e.user_id AND s.interval_id=e.interval_id
 ), removed AS (
  DELETE FROM public.focus_interval_clock c USING expired e
  WHERE c.user_id=e.user_id AND c.interval_id=e.interval_id RETURNING 1
 ) SELECT count(*)::integer FROM removed
$$;
