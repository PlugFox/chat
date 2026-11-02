-- Temporary chats (docs/protocol.md, "Temporary chats"): a chat with an expiry
-- renewed while the user is active, deleted by the server's sweep once past it.
ALTER TABLE chats ADD COLUMN expires_at timestamptz;
CREATE INDEX chats_expiry_idx ON chats (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX chats_temporary_user_idx ON chats (user_id) WHERE expires_at IS NOT NULL;
