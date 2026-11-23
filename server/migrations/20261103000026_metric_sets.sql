-- Sets of an exercise (docs/protocol.md, "Registers"; D-128): a metric whose
-- entries of a day are sets is shown with their count and the best of them,
-- and the agent may propose several entries at once. Catalog data, the same
-- for every account.

ALTER TABLE metrics ADD COLUMN sets boolean NOT NULL DEFAULT false;
UPDATE metrics SET sets = true WHERE category = 'exercise';
