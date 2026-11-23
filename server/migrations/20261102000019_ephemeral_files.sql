-- Files not kept (docs/protocol.md, "Files"; D-107): the object leaves the
-- store once a reply that read it is complete, about an hour after the send otherwise, and
-- the row stays for the description. Whether a file was kept and when its
-- object went are metadata the server needs (docs/threat-model.md, "Metadata").

ALTER TABLE files
    ADD COLUMN ephemeral boolean NOT NULL DEFAULT false,
    ADD COLUMN object_gone_at timestamptz,
    -- When a message took the file: the hour a file not kept may wait counts from here.
    ADD COLUMN attached_at timestamptz,
    ADD CHECK (ephemeral OR object_gone_at IS NULL),
    -- An original is only ever kept: the model never reads it.
    ADD CHECK (NOT (ephemeral AND original));

CREATE INDEX files_ephemeral ON files (attached_at) WHERE ephemeral AND object_gone_at IS NULL;
