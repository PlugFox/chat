-- How many times the model was asked to describe a file (docs/protocol.md,
-- "Files"; D-102). A try is counted before it runs, so a server that dies
-- in one has spent it; after three, later turns name the file without a
-- description. A count of tries is metadata the server keeps about its own
-- work (docs/threat-model.md, "Metadata").

ALTER TABLE files
    ADD COLUMN describe_attempts smallint NOT NULL DEFAULT 0 CHECK (describe_attempts BETWEEN 0 AND 3);

-- The sweep looks for rows whose upload never finished.
CREATE INDEX files_not_uploaded ON files (created_at) WHERE uploaded_at IS NULL;
