-- Files in chats (docs/protocol.md, "Files"; D-101): a row per file, whose
-- content is an encrypted object in the file store, named by the file id.
-- The content key, the client's preview and the model's description are
-- records sealed to the chat's scope. Sizes, times and which message a file
-- belongs to are metadata the server needs (docs/threat-model.md, "Metadata").

CREATE TABLE files (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    -- The chat the records are sealed to. Not a foreign key: a new chat's
    -- files are uploaded before its first message creates it.
    chat_id uuid NOT NULL,
    -- Bytes of the object (the plaintext of at most 50 MB, encrypted).
    size integer NOT NULL CHECK (size BETWEEN 1 AND 52000000),
    key bytea NOT NULL CHECK (length(key) BETWEEN 1 AND 1024),
    preview bytea CHECK (length(preview) <= 65536),
    description bytea CHECK (length(description) <= 8192),
    -- An upload in progress holds the row, so two cannot write one object.
    upload_started_at timestamptz,
    uploaded_at timestamptz,
    -- The user message the file is attached to; null until a send takes it.
    message_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Deleting the chat deletes its messages and so their files. A tombstone
    -- keeps its row: the message deletion deletes its files itself.
    FOREIGN KEY (chat_id, message_id) REFERENCES messages (chat_id, id) ON DELETE CASCADE
);

CREATE INDEX files_user ON files (user_id);
CREATE INDEX files_message ON files (chat_id, message_id);
CREATE INDEX files_unattached ON files (created_at) WHERE message_id IS NULL;

-- Objects whose rows are gone, however they went (a message, a chat, an
-- account, the sweep of unattached files): a background task deletes them
-- from the store, so no deletion path can leave an object behind.
CREATE TABLE file_objects_gone (
    id uuid PRIMARY KEY,
    gone_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION files_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO file_objects_gone (id) SELECT id FROM gone ON CONFLICT DO NOTHING;
    RETURN NULL;
END
$$;

CREATE TRIGGER files_gone AFTER DELETE ON files
    REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION files_gone();

-- `read_file` in the access log: the file the model opened.
ALTER TABLE access_log
    ADD COLUMN file_id uuid,
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check
        CHECK (tool IN ('read_register', 'session_context', 'read_history', 'read_file')),
    ADD CHECK ((tool = 'read_file') = (file_id IS NOT NULL));
