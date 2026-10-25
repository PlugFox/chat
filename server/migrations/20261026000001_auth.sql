-- Users, identities, devices, sessions, pending sign-ins and the audit log
-- (docs/auth.md). Every user-owned row cascades from `users`: deleting a user
-- deletes everything (docs/auth.md, "Account deletion").

CREATE TABLE users (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('google', 'email')),
    issuer text NOT NULL,
    subject text NOT NULL,
    -- Normalized (lower-case). For `email` identities it equals `subject`.
    email text,
    email_verified boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, issuer, subject)
);
CREATE INDEX identities_user_idx ON identities (user_id);
-- Auto-linking looks up verified addresses only.
CREATE INDEX identities_verified_email_idx ON identities (email) WHERE email_verified;

CREATE TABLE devices (
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, id)
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    identity_id uuid REFERENCES identities ON DELETE SET NULL,
    provider text NOT NULL CHECK (provider IN ('google', 'email')),
    device_id uuid,
    -- SHA-256 of the current refresh token; the previous one is kept for the
    -- concurrent-refresh window and reuse detection.
    refresh_hash bytea NOT NULL CHECK (length(refresh_hash) = 32),
    refresh_generation integer NOT NULL DEFAULT 0 CHECK (refresh_generation >= 0),
    prev_refresh_hash bytea CHECK (length(prev_refresh_hash) = 32),
    rotated_at timestamptz,
    ip inet,
    country text CHECK (country ~ '^[A-Z]{2}$'),
    user_agent text CHECK (length(user_agent) <= 512),
    timezone text CHECK (length(timezone) <= 64),
    locale text CHECK (length(locale) <= 16),
    client_version text CHECK (length(client_version) <= 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    revoked_reason text CHECK (revoked_reason IN (
        'sign_out', 'revoked_by_user', 'device_replaced', 'identity_unlinked',
        'refresh_reused', 'idle', 'account_deleted'
    )),
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
    FOREIGN KEY (user_id, device_id) REFERENCES devices (user_id, id) ON DELETE SET NULL (device_id)
);
CREATE INDEX sessions_live_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_live_device_idx ON sessions (user_id, device_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_revoked_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;

-- One pending code per address; `id` is the pending id the client holds.
CREATE TABLE email_codes (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    code_hmac bytea NOT NULL CHECK (length(code_hmac) = 32),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    -- Sends within the current one-hour window.
    sends smallint NOT NULL CHECK (sends >= 1),
    window_started_at timestamptz NOT NULL,
    sent_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    -- Set when the code links an address to a signed-in user instead of signing in.
    link_user_id uuid REFERENCES users ON DELETE CASCADE
);
CREATE INDEX email_codes_expires_idx ON email_codes (expires_at);

CREATE TABLE oidc_flows (
    id uuid PRIMARY KEY,
    state text NOT NULL,
    nonce text NOT NULL,
    pkce_verifier text NOT NULL,
    link_user_id uuid REFERENCES users ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_flows_expires_idx ON oidc_flows (expires_at);

-- Append-only. No content, codes, tokens or addresses in `details`.
CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid REFERENCES users ON DELETE CASCADE,
    session_id uuid,
    kind text NOT NULL CHECK (kind ~ '^[a-z_]+\.[a-z_]+$'),
    ip inet,
    country text CHECK (country ~ '^[A-Z]{2}$'),
    user_agent text CHECK (length(user_agent) <= 512),
    details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, id DESC) WHERE user_id IS NOT NULL;
CREATE INDEX audit_events_created_idx ON audit_events USING brin (created_at);
