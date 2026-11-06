UPDATE inbound_webhook h SET revoked_at = now()
WHERE h.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM membership m
    WHERE m.user_id = h.user_id AND m.workspace_id = h.workspace_id
);
