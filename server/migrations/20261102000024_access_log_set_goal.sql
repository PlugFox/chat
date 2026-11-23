-- Goals the agent proposes in the access log (docs/protocol.md, "Permissions
-- and the access log"; D-124). The metric is in the clear like a proposed
-- entry's; the goal stays sealed in `reason`.

ALTER TABLE access_log
    DROP CONSTRAINT access_log_tool_check,
    ADD CONSTRAINT access_log_tool_check
        CHECK (tool IN (
            'read_register', 'session_context', 'read_history', 'read_file',
            'add_measurement', 'web_fetch', 'run_code', 'get_weather', 'set_goal'
        )),
    ADD CHECK (tool <> 'set_goal' OR metric IS NOT NULL);
