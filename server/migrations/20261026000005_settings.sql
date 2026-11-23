-- Settings (docs/protocol.md, "Settings"): one `settings.value` record per
-- plaintext key, sealed to the account's `settings` scope.

CREATE TABLE settings (
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-z0-9._-]{1,64}$'),
    record bytea NOT NULL CHECK (length(record) BETWEEN 1 AND 65536),
    rev bigint NOT NULL CHECK (rev >= 1),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, key)
);
