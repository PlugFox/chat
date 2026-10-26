-- Saved messages (docs/protocol.md, "Saved messages"): references only. A
-- tombstone leaves them in its transaction; a deleted chat or account takes
-- them along through its messages.
CREATE TABLE saved_messages (
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    chat_id uuid NOT NULL,
    message_id bigint NOT NULL,
    -- Milliseconds, exact, so a page cursor compares without rounding.
    saved_at bigint NOT NULL,
    PRIMARY KEY (user_id, chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES messages ON DELETE CASCADE
);
CREATE INDEX saved_messages_page_idx ON saved_messages (user_id, saved_at DESC, chat_id DESC, message_id DESC);
CREATE INDEX saved_messages_message_idx ON saved_messages (chat_id, message_id);
