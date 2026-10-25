-- Account keys, ARK wraps, scopes and scope keys (docs/crypto.md,
-- docs/protocol.md "Keys"). Everything here is public or wrapped under keys
-- the server never sees.

CREATE TABLE account_keys (
    user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
    commitment bytea NOT NULL CHECK (length(commitment) = 32),
    writer_public_key bytea NOT NULL CHECK (length(writer_public_key) = 32),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- `method` follows the wrap format: 1 passkey, 2 recovery, 4 remembered device.
CREATE TABLE ark_wraps (
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    id uuid NOT NULL,
    method smallint NOT NULL CHECK (method IN (1, 2, 4)),
    wrap bytea NOT NULL CHECK (length(wrap) <= 1024),
    -- The session that remembered its device; the wrap goes to it only and
    -- ends with it (docs/crypto.md, "Remember this device").
    session_id uuid REFERENCES sessions ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id),
    CHECK ((method = 4) = (session_id IS NOT NULL))
);
CREATE UNIQUE INDEX ark_wraps_recovery_idx ON ark_wraps (user_id) WHERE method = 2;
CREATE UNIQUE INDEX ark_wraps_session_idx ON ark_wraps (session_id);

-- A session that ends, or reports another device, loses its device wrap,
-- whichever code path ends it (sign-out, revocation, idle sweep).
CREATE FUNCTION ark_wraps_end_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM ark_wraps WHERE session_id = NEW.id;
    RETURN NULL;
END
$$;
CREATE TRIGGER sessions_end_device_wrap
    AFTER UPDATE OF revoked_at, device_id ON sessions
    FOR EACH ROW
    WHEN (NEW.revoked_at IS NOT NULL OR NEW.device_id IS DISTINCT FROM OLD.device_id)
    EXECUTE FUNCTION ark_wraps_end_session();

CREATE TABLE scopes (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN (
        'settings', 'audit', 'profile:basics', 'profile:medical', 'profile:lifestyle'
    )),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scopes_user_idx ON scopes (user_id);

CREATE TABLE scope_keys (
    scope_id uuid NOT NULL REFERENCES scopes ON DELETE CASCADE,
    key_version integer NOT NULL CHECK (key_version >= 1),
    public_key bytea NOT NULL CHECK (length(public_key) = 32),
    wrapped_private_key bytea NOT NULL CHECK (length(wrapped_private_key) <= 256),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope_id, key_version)
);
