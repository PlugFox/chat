-- A chat's settings (docs/protocol.md, "Chat settings"): plaintext JSON the
-- server checks before storing (D-093).
ALTER TABLE chats
    ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'
        CONSTRAINT chats_settings_check CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) <= 4096);
