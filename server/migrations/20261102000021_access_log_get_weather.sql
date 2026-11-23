-- Weather at the place found by the session's IP (docs/protocol.md, "Permissions
-- and the access log"; D-116). The place stays sealed in `reason`.

ALTER TABLE access_log
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check
        CHECK (tool IN ('read_register', 'session_context', 'read_history', 'read_file', 'add_measurement', 'web_fetch', 'run_code', 'get_weather'));
