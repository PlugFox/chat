-- Chats and messages (docs/protocol.md, "Chats and messages"). Titles and
-- messages are records sealed to the chat's scope key; everything else here
-- is metadata the server needs (docs/threat-model.md, "Metadata").

ALTER TABLE scopes DROP CONSTRAINT scopes_kind_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_kind_check CHECK (kind IN (
    'settings', 'audit', 'profile:basics', 'profile:medical', 'profile:lifestyle', 'chat'
));

-- A chat's id is its scope id, so deleting the scope deletes the chat.
CREATE TABLE chats (
    id uuid PRIMARY KEY REFERENCES scopes ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    title bytea CHECK (length(title) <= 2048),
    -- The next message id: ids are dense, allocated under this row's lock.
    next_message_id bigint NOT NULL DEFAULT 0 CHECK (next_message_id BETWEEN 0 AND 4294967296),
    rev bigint NOT NULL DEFAULT 0,
    pin smallint CHECK (pin BETWEEN 0 AND 31),
    archived_at timestamptz,
    turn_id uuid,
    turn_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Milliseconds, exact, so a page cursor compares without rounding.
    updated_at bigint NOT NULL,
    CHECK (pin IS NULL OR archived_at IS NULL)
);
CREATE INDEX chats_page_idx ON chats (user_id, updated_at DESC, id DESC);

-- `author`: 1 user, 2 assistant, 3 tool, 4 summary (as in the record AAD).
-- `state`: 1 complete, 2 streaming, 3 cancelled, 4 failed.
CREATE TABLE messages (
    chat_id uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
    id bigint NOT NULL CHECK (id BETWEEN 0 AND 4294967295),
    author smallint NOT NULL CHECK (author BETWEEN 1 AND 4),
    state smallint NOT NULL CHECK (state BETWEEN 1 AND 4),
    rev bigint NOT NULL,
    record bytea CHECK (length(record) <= 262144),
    seq integer,
    -- The user's message: the client's key for resends and the turn it started.
    idempotency_key uuid,
    turn_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    PRIMARY KEY (chat_id, id),
    CHECK ((record IS NULL) = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX messages_idempotency_idx ON messages (chat_id, idempotency_key);
CREATE INDEX messages_streaming_idx ON messages (chat_id) WHERE state = 2;
