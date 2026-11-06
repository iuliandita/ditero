ALTER POLICY "membership_key_grant_insert" ON public.membership_key
WITH CHECK (
 EXISTS (
  SELECT 1 FROM public.membership target
  WHERE target.id = membership_key.membership_id
    AND target.user_id = membership_key.user_id
    AND target.workspace_id = membership_key.workspace_id
 )
 AND (
  user_id = current_setting('ditero.user_id', true)
  OR (
   granted_by = current_setting('ditero.user_id', true)
   AND EXISTS (
    SELECT 1 FROM public.membership caller
    WHERE caller.workspace_id = membership_key.workspace_id
      AND caller.user_id = current_setting('ditero.user_id', true)
   )
  )
 )
);
--> statement-breakpoint
-- Enforce the same column boundary for custom roles and inherited table grants.
CREATE FUNCTION public.guard_key_grant_request_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['state', 'granted_at', 'failure_reason'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'granted_at', 'failure_reason']) THEN
  RAISE EXCEPTION 'key grant request identity is immutable' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_key_grant_request_update() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER key_grant_request_update_columns
BEFORE UPDATE ON public.key_grant_request
FOR EACH ROW EXECUTE FUNCTION public.guard_key_grant_request_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prune_focus_intervals() FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ditero_runtime') THEN
  REVOKE UPDATE ON public.key_grant_request FROM ditero_runtime;
  GRANT UPDATE (state, granted_at, failure_reason) ON public.key_grant_request TO ditero_runtime;
  GRANT EXECUTE ON FUNCTION public.prune_focus_intervals() TO ditero_runtime;
 END IF;
END $$;
