CREATE FUNCTION public.import_history_claim_fields(claim jsonb, prefix text)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    prefix || '_kind', claim->'kind',
    prefix || '_namespace', CASE WHEN claim->>'kind' = 'source_claim' THEN claim->'sourceNamespace' ELSE 'null'::jsonb END,
    prefix || '_principal_id', CASE WHEN claim->>'kind' = 'source_claim' THEN claim->'sourcePrincipalId' ELSE 'null'::jsonb END,
    prefix || '_name', CASE WHEN claim->>'kind' = 'source_claim' THEN claim->'displayName' ELSE 'null'::jsonb END
  )
$$;
--> statement-breakpoint
CREATE FUNCTION public.import_history_expected_row(collection text, payload jsonb, target text, actor text, ingestion timestamptz)
RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'id', target,
    'source_namespace', payload#>'{sourceRef,namespace}',
    'source_row_id', payload#>'{sourceRef,id}',
    'provenance_redacted_at', NULL
  ) || CASE collection
    WHEN 'comments' THEN jsonb_build_object(
      'task_id', payload->'targetParentId', 'author_id', NULL,
      'body', payload->'body', 'created_at', (payload->>'createdAt')::timestamptz,
      'edited_at', (payload->>'editedAt')::timestamptz, 'imported_at', ingestion
    ) || public.import_history_claim_fields(payload->'author', 'historical_author')
    WHEN 'templates' THEN jsonb_build_object(
      'workspace_id', payload->'targetParentId', 'created_by', actor,
      'kind', payload->'kind', 'name', payload->'name', 'icon', payload->'icon',
      'content', payload->'content', 'imported_at', ingestion
    ) || public.import_history_claim_fields(payload->'creator', 'historical_creator')
    WHEN 'completionEvents' THEN jsonb_build_object(
      'task_id', payload->'targetParentId', 'occurred_at', (payload->>'occurredAt')::timestamptz,
      'ingested_at', ingestion, 'action', payload->'action',
      'before_due_at', (payload->>'beforeDueAt')::timestamptz,
      'before_due_all_day', payload->'beforeDueAllDay', 'before_done', payload->'beforeDone',
      'after_due_at', (payload->>'afterDueAt')::timestamptz, 'after_done', payload->'afterDone',
      'habit_date', payload->'habitDate', 'before_habit_status', payload->'beforeHabitStatus',
      'after_habit_status', payload->'afterHabitStatus',
      'origin_kind', payload#>'{origin,kind}',
      'origin_mechanism', CASE WHEN payload#>>'{origin,kind}' = 'source_claim' THEN payload#>'{origin,mechanism}' ELSE 'null'::jsonb END,
      'origin_label', CASE WHEN payload#>>'{origin,kind}' = 'source_claim' THEN payload#>'{origin,label}' ELSE 'null'::jsonb END
    ) || public.import_history_claim_fields(payload->'actor', 'actor')
    ELSE NULL END
$$;
--> statement-breakpoint
CREATE FUNCTION public.import_history_insert_proof(history_collection text, candidate jsonb, ledger boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  actor text := current_setting('ditero.user_id', true);
  job text := nullif(current_setting('ditero.history_job', true), '');
  position text := nullif(current_setting('ditero.history_ordinal', true), '');
  item public.import_item%ROWTYPE;
  cursor integer;
  parent jsonb;
  tuple jsonb;
  parent_workspace text;
  parent_list text;
  actual_workspace text;
  actual_list text;
  content jsonb;
  expected jsonb;
BEGIN
  IF job IS NULL OR position IS NULL OR position !~ '^[0-9]{1,5}$' THEN RETURN false; END IF;
  PERFORM 1 FROM public."user" WHERE id = actor AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT i.* INTO item FROM public.import_item i
    JOIN public.import_job j ON j.id = i.job_id
    JOIN public.import_source s ON s.id = j.source_id
    WHERE i.job_id = job AND i.ordinal = position::integer AND i.collection = history_collection
      AND i.disposition = 'ensure' AND i.phase = 'history-' || history_collection
      AND j.owner_user_id = actor AND s.owner_user_id = actor
      AND j.planner_version = 5 AND j.apply_supported AND s.schema_version = 2 AND s.format = 'ditero'
      AND j.report->>'plannerVersion' = '5' AND j.report->>'applySupported' = 'true';
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT next_ordinal INTO cursor FROM public.import_run
    WHERE job_id = job AND owner_user_id = actor AND state IN ('pending', 'running') FOR UPDATE;
  IF NOT FOUND OR cursor <> item.ordinal THEN RETURN false; END IF;
  parent := item.dependency_proof->'parent';
  tuple := item.dependency_proof->'ledger';
  parent_workspace := parent->>'workspaceId';
  IF parent->>'id' IS DISTINCT FROM item.payload->>'targetParentId'
    OR tuple->>'targetParentId' IS DISTINCT FROM parent->>'id'
    OR tuple->>'collection' IS DISTINCT FROM history_collection
    OR item.payload->>'collection' IS DISTINCT FROM history_collection
    OR item.payload#>>'{sourceRef,collection}' IS DISTINCT FROM history_collection
    OR tuple->>'sourceNamespace' IS DISTINCT FROM item.payload#>>'{sourceRef,namespace}'
    OR tuple->>'sourceId' IS DISTINCT FROM item.payload#>>'{sourceRef,id}'
    OR tuple->>'sourceIdHash' IS DISTINCT FROM encode(sha256(convert_to(tuple->>'sourceId', 'UTF8')), 'hex')
    OR (history_collection = 'templates' AND (parent->>'kind' <> 'workspace' OR parent->>'id' <> parent_workspace))
    OR (history_collection <> 'templates' AND parent->>'kind' <> 'task')
  THEN RETURN false; END IF;
  PERFORM 1 FROM public.workspace WHERE id = parent_workspace FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM public.membership WHERE id = parent->>'membershipId'
    AND user_id = actor AND workspace_id = parent_workspace AND role IN ('owner', 'admin', 'member') FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF history_collection <> 'templates' THEN
    SELECT t.list_id, l.workspace_id INTO parent_list, actual_workspace
      FROM public.task t JOIN public.list l ON l.id = t.list_id WHERE t.id = parent->>'id';
    IF NOT FOUND OR actual_workspace <> parent_workspace THEN RETURN false; END IF;
    PERFORM 1 FROM public.list WHERE id = parent_list AND workspace_id = parent_workspace FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT t.list_id, l.workspace_id INTO actual_list, actual_workspace
      FROM public.task t JOIN public.list l ON l.id = t.list_id WHERE t.id = parent->>'id' FOR SHARE OF t;
    IF NOT FOUND OR actual_list <> parent_list OR actual_workspace <> parent_workspace THEN RETURN false; END IF;
    IF parent->>'dependencySourceKey' IS NULL THEN
      IF parent->>'listId' IS DISTINCT FROM actual_list THEN RETURN false; END IF;
    ELSE
      PERFORM 1 FROM public.import_item p JOIN public.import_job j ON j.id = p.job_id
        JOIN public.import_source_map m ON m.source_id = j.source_id AND m.source_key = p.source_key
        WHERE p.job_id = job AND p.source_key = parent->>'dependencySourceKey' AND p.ordinal < item.ordinal
          AND p.collection = 'tasks' AND p.disposition = 'ensure' AND p.target_id = parent->>'id'
          AND p.payload->>'listId' = actual_list AND p.dependency_proof#>>'{workspace,targetId}' = parent_workspace
          AND m.owner_user_id = actor AND m.collection = 'tasks' AND m.target_id = p.target_id
          AND m.target_workspace_id = parent_workspace AND m.content_digest = p.content_digest;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;
  END IF;
  IF item.target_precondition->>'kind' IS DISTINCT FROM 'unmapped'
    OR item.target_precondition->>'authorizedTargetId' IS DISTINCT FROM item.target_id
    OR EXISTS (SELECT 1 FROM public.import_history_ledger l WHERE l.collection::text = history_collection
      AND ((l.target_parent_id = tuple->>'targetParentId'
        AND l.source_namespace::text = tuple->>'sourceNamespace'
        AND l.source_row_id_sha256 = tuple->>'sourceIdHash') OR l.target_id = item.target_id))
  THEN RETURN false; END IF;
  expected := public.import_history_expected_row(history_collection, item.payload, item.target_id, actor,
    date_trunc('milliseconds', transaction_timestamp()));
  IF NOT ledger THEN RETURN candidate = expected; END IF;
  IF candidate->>'collection' IS DISTINCT FROM history_collection
    OR candidate->>'target_parent_id' IS DISTINCT FROM tuple->>'targetParentId'
    OR candidate->>'source_namespace' IS DISTINCT FROM tuple->>'sourceNamespace'
    OR candidate->>'source_row_id' IS DISTINCT FROM tuple->>'sourceId'
    OR candidate->>'source_row_id_sha256' IS DISTINCT FROM tuple->>'sourceIdHash'
    OR candidate->>'target_id' IS DISTINCT FROM item.target_id
    OR candidate->>'content_digest' IS DISTINCT FROM item.content_digest
    OR candidate->>'id' !~ '^[0-9a-f]{64}$'
    OR (candidate->>'created_at')::timestamptz IS DISTINCT FROM transaction_timestamp()::timestamptz(3)
  THEN RETURN false; END IF;
  CASE history_collection
    WHEN 'comments' THEN SELECT to_jsonb(c) INTO content FROM public.comment c WHERE id = item.target_id;
    WHEN 'templates' THEN SELECT to_jsonb(t) INTO content FROM public.template t WHERE id = item.target_id;
    WHEN 'completionEvents' THEN SELECT to_jsonb(e) INTO content FROM public.imported_completion_event e WHERE id = item.target_id;
    ELSE RETURN false;
  END CASE;
  RETURN FOUND AND content = expected;
END
$$;
--> statement-breakpoint
CREATE POLICY comment_history_item_insert ON public.comment FOR INSERT
  WITH CHECK (public.import_history_insert_proof('comments', to_jsonb(comment)));
--> statement-breakpoint
CREATE POLICY template_history_item_insert ON public.template FOR INSERT
  WITH CHECK (public.import_history_insert_proof('templates', to_jsonb(template)));
--> statement-breakpoint
CREATE POLICY imported_completion_event_item_insert ON public.imported_completion_event FOR INSERT
  WITH CHECK (public.import_history_insert_proof('completionEvents', to_jsonb(imported_completion_event)));
--> statement-breakpoint
CREATE POLICY import_history_ledger_item_insert ON public.import_history_ledger FOR INSERT
  WITH CHECK (public.import_history_insert_proof(collection::text, to_jsonb(import_history_ledger), true));
--> statement-breakpoint
ALTER POLICY import_run_owner_insert ON public.import_run WITH CHECK (
  owner_user_id = current_setting('ditero.user_id', true)
  AND EXISTS (SELECT 1 FROM public.import_job j WHERE j.id = import_run.job_id
    AND j.owner_user_id = import_run.owner_user_id AND j.planner_version IN (2,3,4,5) AND j.apply_supported)
);
--> statement-breakpoint
ALTER POLICY import_run_owner_update ON public.import_run
  USING (owner_user_id = current_setting('ditero.user_id', true))
  WITH CHECK (owner_user_id = current_setting('ditero.user_id', true)
    AND EXISTS (SELECT 1 FROM public.import_job j WHERE j.id = import_run.job_id
      AND j.owner_user_id = import_run.owner_user_id AND j.planner_version IN (2,3,4,5) AND j.apply_supported));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_imported_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  privileged boolean;
BEGIN
  SELECT r.rolsuper OR r.rolbypassrls
    INTO privileged
    FROM pg_roles r
    WHERE r.rolname = current_user;
  IF NOT coalesce(privileged, false) THEN
    IF TG_TABLE_NAME = 'imported_completion_event'
      OR (TG_TABLE_NAME = 'comment' AND (NEW.source_namespace IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.source_namespace IS NOT NULL)))
      OR (TG_TABLE_NAME = 'template' AND (NEW.source_namespace IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.source_namespace IS NOT NULL)))
    THEN
      IF TG_OP <> 'INSERT' OR NOT coalesce(public.import_history_insert_proof(
        CASE TG_TABLE_NAME WHEN 'comment' THEN 'comments' WHEN 'template' THEN 'templates' ELSE 'completionEvents' END,
        to_jsonb(NEW)), false) THEN
        RAISE EXCEPTION 'imported history writes require an exact saved item' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'comment' THEN
    IF OLD.source_namespace IS NULL AND NEW.source_namespace IS NULL THEN RETURN NEW; END IF;
    IF OLD.source_namespace IS NULL OR NEW.source_namespace IS NULL
      OR ROW(OLD.id, OLD.task_id, OLD.author_id, OLD.body, OLD.created_at, OLD.edited_at, OLD.source_namespace, OLD.source_row_id, OLD.imported_at)
        IS DISTINCT FROM
        ROW(NEW.id, NEW.task_id, NEW.author_id, NEW.body, NEW.created_at, NEW.edited_at, NEW.source_namespace, NEW.source_row_id, NEW.imported_at)
    THEN
      RAISE EXCEPTION 'imported comment content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.historical_author_kind, OLD.historical_author_namespace, OLD.historical_author_principal_id, OLD.historical_author_name)
      IS DISTINCT FROM ROW(NEW.historical_author_kind, NEW.historical_author_namespace, NEW.historical_author_principal_id, NEW.historical_author_name) THEN
      RAISE EXCEPTION 'imported comment claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'template' THEN
    IF OLD.source_namespace IS NULL AND NEW.source_namespace IS NULL THEN RETURN NEW; END IF;
    IF OLD.source_namespace IS NULL OR NEW.source_namespace IS NULL
      OR ROW(OLD.id, OLD.workspace_id, OLD.kind, OLD.name, OLD.icon, OLD.content, OLD.created_by, OLD.source_namespace, OLD.source_row_id, OLD.imported_at)
        IS DISTINCT FROM
        ROW(NEW.id, NEW.workspace_id, NEW.kind, NEW.name, NEW.icon, NEW.content, NEW.created_by, NEW.source_namespace, NEW.source_row_id, NEW.imported_at)
    THEN
      RAISE EXCEPTION 'imported template content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.historical_creator_kind, OLD.historical_creator_namespace, OLD.historical_creator_principal_id, OLD.historical_creator_name)
      IS DISTINCT FROM ROW(NEW.historical_creator_kind, NEW.historical_creator_namespace, NEW.historical_creator_principal_id, NEW.historical_creator_name) THEN
      RAISE EXCEPTION 'imported template claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(OLD.id, OLD.task_id, OLD.source_namespace, OLD.source_row_id, OLD.occurred_at, OLD.ingested_at,
           OLD.action, OLD.before_due_at, OLD.before_due_all_day, OLD.before_done, OLD.after_due_at,
           OLD.after_done, OLD.habit_date, OLD.before_habit_status, OLD.after_habit_status)
      IS DISTINCT FROM
       ROW(NEW.id, NEW.task_id, NEW.source_namespace, NEW.source_row_id, NEW.occurred_at, NEW.ingested_at,
           NEW.action, NEW.before_due_at, NEW.before_due_all_day, NEW.before_done, NEW.after_due_at,
           NEW.after_done, NEW.habit_date, NEW.before_habit_status, NEW.after_habit_status) THEN
      RAISE EXCEPTION 'imported event content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.actor_kind, OLD.actor_namespace, OLD.actor_principal_id, OLD.actor_name,
              OLD.origin_kind, OLD.origin_mechanism, OLD.origin_label)
      IS DISTINCT FROM
          ROW(NEW.actor_kind, NEW.actor_namespace, NEW.actor_principal_id, NEW.actor_name,
              NEW.origin_kind, NEW.origin_mechanism, NEW.origin_label) THEN
      RAISE EXCEPTION 'imported event claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_import_history_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.rolsuper OR r.rolbypassrls INTO privileged
      FROM pg_roles r WHERE r.rolname = current_user;
    IF NOT coalesce(privileged, false) THEN
      IF TG_TABLE_NAME <> 'import_history_ledger' THEN
        RAISE EXCEPTION 'import history redaction remains closed' USING ERRCODE = '42501';
      END IF;
      IF NOT coalesce(public.import_history_insert_proof(NEW.collection::text, to_jsonb(NEW), true), false) THEN
        RAISE EXCEPTION 'import history ledger writes require an exact saved item'
          USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'import history ledger is immutable' USING ERRCODE = '23514';
END;
$$;

--> statement-breakpoint
ALTER POLICY "import_item_owner_insert" ON "import_item" WITH CHECK (
  EXISTS (
    SELECT 1 FROM import_job j
    WHERE j.created_txid = txid_current()
      AND j.id = import_item.job_id
      AND j.owner_user_id = current_setting('ditero.user_id', true)
      AND (
        j.planner_version = 1
        OR (
          j.planner_version IN (2, 3, 4)
          AND (
            import_item.disposition <> 'ensure'
            OR (
              import_item.phase IS NOT NULL
              AND import_item.content_digest IS NOT NULL
              AND import_item.target_precondition IS NOT NULL
              AND import_item.dependency_proof IS NOT NULL
            )
          )
        )
        OR (
          j.planner_version = 5
          AND j.report->>'plannerVersion' = '5'
          AND (
            (NOT j.apply_supported AND j.report->>'applySupported' = 'false'
              AND j.report->>'applyBlockedReason' = 'history-apply-unsupported')
            OR (j.apply_supported AND j.report->>'applySupported' = 'true'
              AND (import_item.disposition <> 'ensure' OR (
                import_item.phase IS NOT NULL AND import_item.content_digest IS NOT NULL
                AND import_item.target_precondition IS NOT NULL AND import_item.dependency_proof IS NOT NULL
              )))
          )
        )
      )
  )
);
--> statement-breakpoint
CREATE FUNCTION public.import_history_require_ledger() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  privileged boolean;
  inserted jsonb := to_jsonb(NEW);
  history_collection text := CASE TG_TABLE_NAME WHEN 'comment' THEN 'comments'
    WHEN 'template' THEN 'templates' ELSE 'completionEvents' END;
  parent_column text := CASE TG_TABLE_NAME WHEN 'template' THEN 'workspace_id' ELSE 'task_id' END;
BEGIN
  IF inserted->>'source_namespace' IS NULL THEN RETURN NEW; END IF;
  SELECT r.rolsuper OR r.rolbypassrls INTO privileged FROM pg_roles r WHERE r.rolname = current_user;
  IF coalesce(privileged, false) THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.import_history_ledger l WHERE l.collection::text = history_collection
    AND l.target_parent_id = inserted->>parent_column AND l.target_id = inserted->>'id'
    AND l.source_namespace::text = inserted->>'source_namespace' AND l.source_row_id = inserted->>'source_row_id';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'imported content requires a durable replay ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER comment_history_requires_ledger AFTER INSERT ON public.comment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.import_history_require_ledger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER template_history_requires_ledger AFTER INSERT ON public.template
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.import_history_require_ledger();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER completion_history_requires_ledger AFTER INSERT ON public.imported_completion_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.import_history_require_ledger();
