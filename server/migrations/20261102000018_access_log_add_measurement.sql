-- Proposed entries in the access log (docs/protocol.md, "Permissions and the
-- access log"; D-106). The metric is in the clear like a read's; the value,
-- day and comment stay sealed in `reason`.

ALTER TABLE access_log
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check
        CHECK (tool IN ('read_register', 'session_context', 'read_history', 'read_file', 'add_measurement')),
    ADD CHECK (tool <> 'add_measurement' OR metric IS NOT NULL);
