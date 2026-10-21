CREATE FUNCTION public.import_provider_content_binding_valid(binding jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE item jsonb; key text;
BEGIN
  IF jsonb_typeof(binding) IS DISTINCT FROM 'object' OR octet_length(binding::text) > 350000
    OR jsonb_typeof(binding->'snapshotSha256') IS DISTINCT FROM 'string'
    OR jsonb_typeof(binding->'provider') IS DISTINCT FROM 'string'
    OR binding->>'snapshotSha256' !~ '^[0-9a-f]{64}$'
    OR binding->>'provider' NOT IN ('todoist','ticktick','microsoft','trello','generic-csv')
    OR jsonb_typeof(binding->'notices') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(binding->'notices') > 512 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['projectFolderName','unsectionedListName','timezone'] LOOP
    IF jsonb_typeof(binding->key) IS DISTINCT FROM 'string' OR octet_length(binding->>key) NOT BETWEEN 1 AND 500
      OR binding->>key !~ '[^[:space:]]' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(binding->'notices') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'path') IS DISTINCT FROM 'string'
      OR octet_length(item->>'path') > 512 OR jsonb_typeof(item->'count') IS DISTINCT FROM 'number'
      OR item->>'count' !~ '^[1-9][0-9]{0,4}$'
      OR jsonb_typeof(item->'code') IS DISTINCT FROM 'string'
      OR item->>'code' NOT IN ('unsupported-field','unsupported-date','unsupported-recurrence','flattened-subtasks',
        'duplicate-row','comments-as-notes','people-excluded','attachments-excluded','reminders-disabled',
        'history-excluded','archive-state','partial-export','completion-unavailable','format-limits','timezone-recurrence','unknown-state')
      THEN RETURN false; END IF;
    IF (item->>'count')::integer > 50000 OR item IS DISTINCT FROM jsonb_build_object('code',item->>'code','path',item->>'path','count',(item->>'count')::integer)
      THEN RETURN false; END IF;
  END LOOP;
  RETURN coalesce(binding->>'sourceNamespace' =
    substr(binding->>'snapshotSha256',1,8) || '-' || substr(binding->>'snapshotSha256',9,4) || '-8' ||
    substr(binding->>'snapshotSha256',14,3) || '-' ||
    translate(substr(binding->>'snapshotSha256',17,1),'0123456789abcdef','89ab89ab89ab89ab') ||
    substr(binding->>'snapshotSha256',18,3) || '-' || substr(binding->>'snapshotSha256',21,12)
    AND binding = jsonb_build_object('kind','provider','version',2,'adapter','provider-content','adapterVersion',1,
      'provider',binding->>'provider','sourceNamespace',binding->>'sourceNamespace','identityMode','snapshot-rows',
      'snapshotSha256',binding->>'snapshotSha256','projectFolderName',binding->>'projectFolderName',
      'unsectionedListName',binding->>'unsectionedListName','timezone',binding->>'timezone','notices',binding->'notices'), false);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.import_provider_binding_valid(binding jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 4096
    AND binding->>'sourceNamespace' ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
    AND binding = jsonb_build_object('kind','provider','version',1,'adapter','ditero-csv',
      'adapterVersion',1,'sourceNamespace',binding->>'sourceNamespace','identityMode','stable-ids',
      'exclusions',jsonb_build_array('assignments','labels','comments','templates','history','attachments',
        'recurrence','reminders','personal-state','folders','list-customization','shopping-fields','task-creation-times','urgency')), false)
  OR coalesce(jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 16384
    AND binding->>'snapshotSha256' ~ '^[0-9a-f]{64}$'
    AND binding->>'sourceNamespace' =
      substr(binding->>'snapshotSha256',1,8) || '-' || substr(binding->>'snapshotSha256',9,4) || '-8' ||
      substr(binding->>'snapshotSha256',14,3) || '-' ||
      translate(substr(binding->>'snapshotSha256',17,1),'0123456789abcdef','89ab89ab89ab89ab') ||
      substr(binding->>'snapshotSha256',18,3) || '-' || substr(binding->>'snapshotSha256',21,12)
    AND jsonb_typeof(binding->'projectFolderName') = 'string'
    AND octet_length(binding->>'projectFolderName') BETWEEN 1 AND 500
    AND binding->>'projectFolderName' ~ '[^[:space:]]'
    AND jsonb_typeof(binding->'unsectionedListName') = 'string'
    AND octet_length(binding->>'unsectionedListName') BETWEEN 1 AND 500
    AND binding->>'unsectionedListName' ~ '[^[:space:]]'
    AND binding = jsonb_build_object('kind','provider','version',1,'adapter','todoist-project-csv',
      'adapterVersion',1,'sourceNamespace',binding->>'sourceNamespace','identityMode','snapshot-rows',
      'snapshotSha256',binding->>'snapshotSha256','projectFolderName',binding->>'projectFolderName',
      'unsectionedListName',binding->>'unsectionedListName',
      'exclusions',jsonb_build_array('dates','recurrence','deadlines','durations','authors','assignments','comments','labels','templates','attachments','history','completion-state','reminders','personal-state','section-project-descriptions','view-settings','shopping-fields','task-creation-times','urgency')), false)
  OR coalesce(jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 4096
    AND binding->>'boardIdSha256' ~ '^[0-9a-f]{64}$'
    AND binding->>'snapshotSha256' ~ '^[0-9a-f]{64}$'
    AND binding->>'sourceNamespace' =
      substr(binding->>'boardIdSha256',1,8) || '-' || substr(binding->>'boardIdSha256',9,4) || '-8' ||
      substr(binding->>'boardIdSha256',14,3) || '-' ||
      translate(substr(binding->>'boardIdSha256',17,1),'0123456789abcdef','89ab89ab89ab89ab') ||
      substr(binding->>'boardIdSha256',18,3) || '-' || substr(binding->>'boardIdSha256',21,12)
    AND binding = jsonb_build_object('kind','provider','version',1,'adapter','trello-board-json',
      'adapterVersion',1,'sourceNamespace',binding->>'sourceNamespace','identityMode','stable-ids',
      'boardIdSha256',binding->>'boardIdSha256','snapshotSha256',binding->>'snapshotSha256',
      'exclusions',jsonb_build_array('dates','completion-state','recurrence','authors','assignments','comments','labels','checklists','attachments','history','reminders','personal-state','custom-fields','covers','stickers','view-settings','plugin-data','task-creation-times','shopping-fields','urgency','board-descriptions')), false)
  OR public.import_provider_content_binding_valid(binding)
$$;
--> statement-breakpoint
ALTER TABLE public.import_source DROP CONSTRAINT import_source_input_binding;
--> statement-breakpoint
ALTER TABLE public.import_source ADD CONSTRAINT import_source_input_binding CHECK (
  (input_binding IS NULL AND format = 'ditero' AND schema_version IN (1,2)) OR
  (input_binding IS NOT NULL AND public.import_provider_binding_valid(input_binding)
    AND schema_version = 1 AND (
      (format = 'ditero-csv' AND input_binding->>'adapter' = 'ditero-csv'
        AND source_user_id = 'migration:ditero-csv:1:' || (input_binding->>'sourceNamespace') || ':owner') OR
      (format = 'todoist-project-csv' AND input_binding->>'adapter' = 'todoist-project-csv'
        AND source_user_id = 'migration:todoist-project-csv:1:' || (input_binding->>'sourceNamespace') || ':owner') OR
      (format = 'provider-content:' || (input_binding->>'provider') AND input_binding->>'adapter' = 'provider-content'
        AND source_user_id = 'provider:1:' || (input_binding->>'provider') || ':' || (input_binding->>'sourceNamespace') || ':owner') OR
      (format = 'trello-board-json' AND input_binding->>'adapter' = 'trello-board-json'
        AND source_user_id = 'migration:trello-board-json:1:' || (input_binding->>'sourceNamespace') || ':owner')
    ))
);
