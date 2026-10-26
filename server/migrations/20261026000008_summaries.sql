-- Summaries (docs/protocol.md, "Compaction"): a summary message covers every
-- message up to `through`, which only summaries have.
ALTER TABLE messages
    ADD COLUMN through bigint CHECK (through BETWEEN 0 AND 4294967295),
    ADD CONSTRAINT messages_summary_through_check CHECK ((through IS NOT NULL) = (author = 4) AND (through IS NULL OR through < id));

-- A chat's current summary: the complete one with the largest `through`.
CREATE INDEX messages_summary_idx ON messages (chat_id, through DESC, id DESC)
    WHERE author = 4 AND state = 1 AND deleted_at IS NULL;
