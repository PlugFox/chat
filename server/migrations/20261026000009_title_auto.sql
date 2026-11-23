-- Whether a chat's title is automatic: the model's titles replace it until
-- the user names the chat (docs/protocol.md, "Titles").
ALTER TABLE chats ADD COLUMN title_auto boolean NOT NULL DEFAULT true;
