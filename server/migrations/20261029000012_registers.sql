-- Registers (docs/protocol.md, "Registers"; D-097): the metric catalog, the
-- same for every account and plaintext, seeded here; each account's
-- registers (one `register` scope per metric it uses) and their entries,
-- whose values are `register.value` records the client seals. Moments,
-- counts and revisions are metadata the server needs
-- (docs/threat-model.md, "Metadata").

ALTER TABLE scopes DROP CONSTRAINT scopes_kind_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_kind_check CHECK (kind IN (
    'settings', 'audit', 'profile:basics', 'profile:medical', 'profile:lifestyle', 'chat', 'notes', 'register'
));

CREATE TABLE metric_categories (
    key text PRIMARY KEY,
    -- Locale → name.
    names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object'),
    position integer NOT NULL UNIQUE
);

-- A key is never reused: entries and grants name metrics by it.
CREATE TABLE metrics (
    key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    category text NOT NULL REFERENCES metric_categories,
    register text NOT NULL CHECK (register IN ('measurements')),
    names jsonb NOT NULL CHECK (jsonb_typeof(names) = 'object'),
    unit text NOT NULL,
    quantity text NOT NULL,
    value_type text NOT NULL CHECK (value_type IN ('decimal', 'integer')),
    precision smallint NOT NULL CHECK (precision BETWEEN 0 AND 6),
    min double precision NOT NULL,
    max double precision NOT NULL CHECK (max > min),
    aggregate text NOT NULL CHECK (aggregate IN ('avg', 'sum')),
    position integer NOT NULL UNIQUE
);

INSERT INTO metric_categories (key, names, position) VALUES
    ('body', '{"en": "Body", "ru": "Тело"}', 10),
    ('activity', '{"en": "Activity", "ru": "Активность"}', 20),
    ('exercise', '{"en": "Exercise", "ru": "Упражнения"}', 30),
    ('nutrition', '{"en": "Nutrition", "ru": "Питание"}', 40);

INSERT INTO metrics (key, category, register, names, unit, quantity, value_type, precision, min, max, aggregate, position) VALUES
    ('body.weight', 'body', 'measurements', '{"en": "Weight", "ru": "Вес"}',
        'kg', 'mass', 'decimal', 1, 1, 500, 'avg', 10),
    ('body.height', 'body', 'measurements', '{"en": "Height", "ru": "Рост"}',
        'cm', 'length', 'decimal', 1, 20, 300, 'avg', 20),
    ('activity.steps', 'activity', 'measurements', '{"en": "Steps", "ru": "Шаги"}',
        'count', 'count', 'integer', 0, 0, 200000, 'sum', 30),
    ('activity.active_energy', 'activity', 'measurements', '{"en": "Energy burned", "ru": "Сожжённые калории"}',
        'kcal', 'energy', 'integer', 0, 0, 20000, 'sum', 40),
    ('exercise.squats', 'exercise', 'measurements', '{"en": "Squats", "ru": "Приседания"}',
        'count', 'count', 'integer', 0, 0, 10000, 'sum', 50),
    ('exercise.push_ups', 'exercise', 'measurements', '{"en": "Push-ups", "ru": "Отжимания"}',
        'count', 'count', 'integer', 0, 0, 10000, 'sum', 60),
    ('nutrition.energy_intake', 'nutrition', 'measurements', '{"en": "Energy eaten", "ru": "Съеденные калории"}',
        'kcal', 'energy', 'integer', 0, 0, 20000, 'sum', 70);

CREATE TABLE registers (
    scope_id uuid PRIMARY KEY REFERENCES scopes ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    metric text NOT NULL REFERENCES metrics,
    UNIQUE (user_id, metric)
);

CREATE TABLE register_entries (
    -- Chosen by the client.
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES account_keys ON DELETE CASCADE,
    scope_id uuid NOT NULL REFERENCES registers ON DELETE CASCADE,
    -- Seconds, UTC: the record's `period_start`.
    occurred_at bigint NOT NULL CHECK (occurred_at BETWEEN -2208988800 AND 7258118400),
    value bytea NOT NULL CHECK (length(value) BETWEEN 1 AND 1024),
    rev bigint NOT NULL CHECK (rev >= 1),
    -- Milliseconds.
    updated_at bigint NOT NULL
);
CREATE INDEX register_entries_page_idx ON register_entries (scope_id, occurred_at DESC, id DESC);
CREATE INDEX register_entries_user_idx ON register_entries (user_id);
