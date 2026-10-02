-- The table owner is a trusted maintainer, including under FORCE RLS.
ALTER TABLE public.workspace_access_scope FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION public.maintain_workspace_access_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.workspace_access_scope (id, user_id, workspace_id)
  VALUES (NEW.id, NEW.user_id, NEW.workspace_id)
  ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, workspace_id = EXCLUDED.workspace_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.maintain_workspace_access_scope() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER membership_workspace_access_scope
AFTER INSERT OR UPDATE ON public.membership
FOR EACH ROW EXECUTE FUNCTION public.maintain_workspace_access_scope();
--> statement-breakpoint
INSERT INTO public.workspace_access_scope (id, user_id, workspace_id)
SELECT id, user_id, workspace_id FROM public.membership;
