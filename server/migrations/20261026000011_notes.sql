-- Notes (docs/protocol.md, "Notes"): the account's one `notes` scope in v1
-- (D-096) and its notes. Titles and bodies are `note.title` and `note.body`
-- records the client seals to that scope; ids, times and revisions are
-- metadata the server needs (docs/threat-model.md, "Metadata").

ALTER TABLE scopes DROP CONSTRAINT scopes_kind_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_kind_check CHECK (kind IN (
    'settings', 'audit', 'profile:basics', 'profile:medical', 'profile:lifestyle', 'chat', 'notes'
));
-- One notebook per account: a second `notes.setup` finds the first scope.
CREATE UNIQUE INDEX scopes_notes_idx ON scopes (user_id) WHERE kind = 'notes';

CREATE TABLE notes (
    -- Chosen by the client.
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    scope_id uuid NOT NULL REFERENCES scopes ON DELETE CASCADE,
    title bytea NOT NULL CHECK (length(title) BETWEEN 1 AND 2048),
    body bytea NOT NULL CHECK (length(body) BETWEEN 1 AND 262144),
    rev bigint NOT NULL CHECK (rev >= 1),
    -- Milliseconds, exact, so a page cursor compares without rounding.
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE INDEX notes_page_idx ON notes (user_id, updated_at DESC, id DESC);
