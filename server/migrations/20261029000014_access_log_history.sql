-- History reads in the access log (docs/protocol.md, "Agent tools (v1)";
-- D-100): `read_history` asks the client for message ids before
-- `message_before` of the request's chat, and the client answers it itself
-- (`answered`).

ALTER TABLE access_log
    ADD COLUMN message_before integer CHECK (message_before >= 1),
    ADD COLUMN message_count integer CHECK (message_count BETWEEN 1 AND 50),
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check CHECK (tool IN ('read_register', 'session_context', 'read_history')),
    DROP CONSTRAINT access_log_outcome_check,
    ADD CONSTRAINT access_log_outcome_check
        CHECK (outcome IN ('approved', 'denied', 'refused', 'timeout', 'cancelled', 'answered')),
    ADD CHECK ((tool = 'read_history') = (message_before IS NOT NULL AND message_count IS NOT NULL));
