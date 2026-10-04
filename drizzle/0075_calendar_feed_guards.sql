ALTER TABLE "calendar_feed" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION calendar_feed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.list_id,NEW.workspace_id,NEW.name,NEW.secret_hash,NEW.hint,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.list_id,OLD.workspace_id,OLD.name,OLD.secret_hash,OLD.hint,OLD.created_at,OLD.expires_at)
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'calendar feed binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calendar_feed_immutable BEFORE UPDATE ON "calendar_feed"
FOR EACH ROW EXECUTE FUNCTION calendar_feed_immutable();
