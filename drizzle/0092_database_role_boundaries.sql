ALTER POLICY "membership_key_grant_insert" ON public.membership_key
WITH CHECK (
 EXISTS (
  SELECT 1 FROM public.membership target
  WHERE target.id = membership_key.membership_id
    AND target.user_id = membership_key.user_id
    AND target.workspace_id = membership_key.workspace_id
 )
 AND granted_by = current_setting('ditero.user_id', true)
 AND (
  user_id = current_setting('ditero.user_id', true)
  OR EXISTS (
   SELECT 1 FROM public.membership caller
   WHERE caller.workspace_id = membership_key.workspace_id
     AND caller.user_id = current_setting('ditero.user_id', true)
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
CREATE FUNCTION public.guard_membership_key_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['enc', 'ciphertext', 'recipient_public_key'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['enc', 'ciphertext', 'recipient_public_key']) THEN
  RAISE EXCEPTION 'membership key identity is immutable' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_membership_key_update() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER membership_key_update_columns
BEFORE UPDATE ON public.membership_key
FOR EACH ROW EXECUTE FUNCTION public.guard_membership_key_update();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prune_focus_intervals() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE runtime_role record;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ditero_runtime') THEN
  REVOKE UPDATE ON public.key_grant_request FROM ditero_runtime;
  GRANT UPDATE (state, granted_at, failure_reason) ON public.key_grant_request TO ditero_runtime;
  REVOKE UPDATE ON public.membership_key FROM ditero_runtime;
  GRANT UPDATE (enc, ciphertext, recipient_public_key) ON public.membership_key TO ditero_runtime;
 END IF;
 -- Preserve existing cleanup authority for custom runtime role names.
 FOR runtime_role IN
  SELECT oid, rolname FROM pg_roles
  WHERE NOT rolsuper
    AND has_table_privilege(oid, 'public.focus_interval_start', 'DELETE')
 LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.prune_focus_intervals() TO %I', runtime_role.rolname);
 END LOOP;
END $$;
