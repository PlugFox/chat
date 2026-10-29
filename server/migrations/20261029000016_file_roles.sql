-- What a send says of each file it attaches (docs/protocol.md, "Files";
-- D-101): whether it is an image's original, which the model never reads,
-- and its plaintext size, which a retry and a turn check the file against.
-- Both are set when a message takes the file and are metadata the server
-- sees in the send anyway (docs/threat-model.md, "Metadata").

ALTER TABLE files
    ADD COLUMN original boolean NOT NULL DEFAULT false,
    ADD COLUMN plain_size integer CHECK (plain_size BETWEEN 0 AND 50000000),
    ADD CHECK ((message_id IS NULL) = (plain_size IS NULL));
