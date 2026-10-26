-- Why a reply failed (D-089): the turn error code only, never error text.
-- `error`: 1 provider.blocked, 2 provider.unreachable, 3 provider.refused,
-- 4 provider.invalid, 5 turn.too_long, 6 turn.timed_out, 7 turn.interrupted.
ALTER TABLE messages ADD COLUMN error smallint CHECK (error > 0);
ALTER TABLE messages ADD CONSTRAINT messages_error_state_check CHECK (error IS NULL OR state = 4);
