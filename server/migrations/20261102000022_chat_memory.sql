-- A chat's memory, which the model rewrites (docs/protocol.md, "Agent tools (v1)"; D-117).
-- A `chat.memory` record of at most 8 KiB of text, padded, in a generous bound.
ALTER TABLE chats ADD COLUMN memory bytea CHECK (length(memory) <= 16384);
