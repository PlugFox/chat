-- The access log (docs/protocol.md, "Permissions and the access log";
-- D-099): every permission request of an agent tool, waiting while
-- `outcome` is null, so any replica can answer it and a reload can ask for
-- it again. Rows outlive their chat and auth session; the reason is an
-- `audit.reason` record sealed to the account's `audit` scope.

CREATE TABLE access_log (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    -- The auth session the request went to; the only one that answers it.
    session_id uuid NOT NULL,
    chat_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    -- The entry of the providers setting the turn runs with.
    provider_id uuid NOT NULL,
    tool text NOT NULL CHECK (tool IN ('read_register', 'session_context')),
    metric text CHECK (length(metric) <= 64),
    scope_id uuid,
    day_from text CHECK (day_from ~ '^\d{4}-\d{2}-\d{2}$'),
    day_to text CHECK (day_to ~ '^\d{4}-\d{2}-\d{2}$'),
    reason bytea NOT NULL,
    outcome text CHECK (outcome IN ('approved', 'denied', 'refused', 'timeout', 'cancelled')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    CHECK ((outcome IS NULL) = (decided_at IS NULL)),
    CHECK ((tool = 'read_register') = (metric IS NOT NULL AND scope_id IS NOT NULL))
);

CREATE INDEX access_log_user ON access_log (user_id, id DESC);
CREATE INDEX access_log_waiting ON access_log (session_id) WHERE outcome IS NULL;
CREATE INDEX access_log_requested ON access_log (requested_at);
