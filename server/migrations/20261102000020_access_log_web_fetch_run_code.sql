-- Web requests and code runs in the access log (docs/protocol.md, "Permissions
-- and the access log"; D-114, D-115). Their URL and code stay sealed in `reason`:
-- a URL can carry what the model knows, so no column holds the host either.

ALTER TABLE access_log
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check
        CHECK (tool IN ('read_register', 'session_context', 'read_history', 'read_file', 'add_measurement', 'web_fetch', 'run_code'));
