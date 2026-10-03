ALTER TABLE "import_job" ADD COLUMN "input_binding" jsonb;--> statement-breakpoint
ALTER TABLE "import_source" ADD COLUMN "input_binding" jsonb;
--> statement-breakpoint
CREATE FUNCTION public.import_provider_binding_valid(binding jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 4096
    AND binding->>'sourceNamespace' ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
    AND binding = jsonb_build_object('kind','provider','version',1,'adapter','ditero-csv',
      'adapterVersion',1,'sourceNamespace',binding->>'sourceNamespace','identityMode','stable-ids',
      'exclusions',jsonb_build_array('assignments','labels','comments','templates','history','attachments',
        'recurrence','reminders','personal-state','folders','list-customization','shopping-fields','task-creation-times','urgency')), false)
$$;
--> statement-breakpoint
ALTER TABLE public.import_source ADD CONSTRAINT import_source_input_binding CHECK (
  (input_binding IS NULL AND format = 'ditero' AND schema_version IN (1,2)) OR
  (input_binding IS NOT NULL AND public.import_provider_binding_valid(input_binding)
    AND format = 'ditero-csv' AND schema_version = 1
    AND source_user_id = 'migration:ditero-csv:1:' || (input_binding->>'sourceNamespace') || ':owner')
);
--> statement-breakpoint
ALTER TABLE public.import_job ADD CONSTRAINT import_job_input_binding CHECK (
  input_binding IS NULL OR (public.import_provider_binding_valid(input_binding) AND planner_version = 4 AND apply_supported)
);
--> statement-breakpoint
CREATE FUNCTION public.import_input_binding_preserve() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.input_binding IS DISTINCT FROM OLD.input_binding THEN
    RAISE EXCEPTION 'import input binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'import_job' AND NOT EXISTS (
    SELECT 1 FROM public.import_source s WHERE s.id = NEW.source_id
      AND s.owner_user_id = NEW.owner_user_id AND s.input_binding IS NOT DISTINCT FROM NEW.input_binding
  ) THEN
    RAISE EXCEPTION 'import input binding does not match source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER import_source_input_binding_preserve BEFORE UPDATE ON public.import_source
  FOR EACH ROW EXECUTE FUNCTION public.import_input_binding_preserve();
--> statement-breakpoint
CREATE TRIGGER import_job_input_binding_preserve BEFORE INSERT OR UPDATE ON public.import_job
  FOR EACH ROW EXECUTE FUNCTION public.import_input_binding_preserve();
