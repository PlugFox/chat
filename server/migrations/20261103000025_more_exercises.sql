-- More exercises in the metric catalog (docs/protocol.md, "Registers"; D-097):
-- pull-ups, crunches and the plank, held for seconds and summed over a day.
-- The catalog is the same for every account and plaintext.

INSERT INTO metrics (key, category, register, names, unit, quantity, value_type, precision, min, max, aggregate, position) VALUES
    ('exercise.pull_ups', 'exercise', 'measurements', '{"en": "Pull-ups", "ru": "Подтягивания"}',
        'count', 'count', 'integer', 0, 0, 10000, 'sum', 62),
    ('exercise.crunches', 'exercise', 'measurements', '{"en": "Crunches", "ru": "Скручивания"}',
        'count', 'count', 'integer', 0, 0, 10000, 'sum', 64),
    ('exercise.plank', 'exercise', 'measurements', '{"en": "Plank", "ru": "Планка"}',
        's', 'duration', 'integer', 0, 0, 36000, 'sum', 66);
