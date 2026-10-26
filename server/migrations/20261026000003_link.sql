-- Device linking (docs/protocol.md, "Keys"): short-lived link sessions of a
-- creating session (one per tab showing a code), each with the one message
-- the unlocked device posts into it, sealed to a key the server never sees.

CREATE TABLE link_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES sessions ON DELETE CASCADE,
    message bytea CHECK (length(message) <= 256),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX link_sessions_session_idx ON link_sessions (session_id);
CREATE INDEX link_sessions_expires_idx ON link_sessions (expires_at);
