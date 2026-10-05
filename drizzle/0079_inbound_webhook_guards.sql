ALTER TABLE "inbound_webhook" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION inbound_webhook_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.list_id,NEW.workspace_id,NEW.name,NEW.secret_hash,NEW.hint,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.list_id,OLD.workspace_id,OLD.name,OLD.secret_hash,OLD.hint,OLD.created_at,OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'webhook binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inbound_webhook_immutable BEFORE UPDATE ON "inbound_webhook"
FOR EACH ROW EXECUTE FUNCTION inbound_webhook_immutable();
--> statement-breakpoint
CREATE POLICY inbound_webhook_insert_scope ON "inbound_webhook" AS RESTRICTIVE FOR INSERT
WITH CHECK (
  user_id = current_setting('ditero.user_id', true)
  AND EXISTS (
    SELECT 1 FROM list l JOIN membership m ON m.workspace_id = l.workspace_id
    WHERE l.id = inbound_webhook.list_id AND l.workspace_id = inbound_webhook.workspace_id
      AND m.user_id = inbound_webhook.user_id AND m.role <> 'viewer'
  )
);
