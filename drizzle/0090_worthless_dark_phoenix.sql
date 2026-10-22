CREATE SCHEMA IF NOT EXISTS "server_private";
--> statement-breakpoint
REVOKE ALL ON SCHEMA "server_private" FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "public"."focus_interval_clock" SET SCHEMA "server_private";
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ditero_runtime') THEN
  GRANT USAGE ON SCHEMA server_private TO ditero_runtime;
  REVOKE ALL ON server_private.focus_interval_clock FROM ditero_runtime;
  GRANT SELECT, INSERT, UPDATE ON server_private.focus_interval_clock TO ditero_runtime;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prune_focus_intervals() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 WITH expired AS MATERIALIZED (
  SELECT user_id, interval_id FROM server_private.focus_interval_clock
  WHERE started_at < now() - interval '14 days'
  ORDER BY started_at LIMIT 500 FOR UPDATE SKIP LOCKED
 ), removed_ids AS (
  DELETE FROM public.focus_interval_start s USING expired e
  WHERE s.user_id=e.user_id AND s.interval_id=e.interval_id
 ), removed AS (
  DELETE FROM server_private.focus_interval_clock c USING expired e
  WHERE c.user_id=e.user_id AND c.interval_id=e.interval_id RETURNING 1
 ) SELECT count(*)::integer FROM removed
$$;
