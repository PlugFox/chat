---
name: add-migration
description: Add a PostgreSQL migration to the Vault Chat server (server/migrations) — a new table, column, constraint, index or seed. Use whenever a feature changes the database schema or its seeded data.
---

# Add a migration

The traps are in `.claude/rules/migrations.md`; this is the procedure.

## Steps

1. **Spec first**: the table's contract is in `docs/protocol.md` (or
   `docs/auth.md`) and every record column's format in `docs/crypto.md`.
   A plaintext column is metadata: check it against
   `docs/threat-model.md#metadata` and add it to that list if it is new.
2. **New file**, never an edit of an applied one: `server/migrations/`
   `YYYYMMDD` of today plus the next six-digit sequence number after the
   last file (`ls server/migrations | tail -1`), and a short name.
3. **Header comment**: what the change is for, with the protocol section
   and the `D-NNN` it implements, and why any plaintext column is needed.
4. **Schema**:
   - a user-owned table references `users` (or a table that does) with
     `ON DELETE CASCADE` (D-039);
   - every rule the server relies on is a `CHECK`, `UNIQUE` or foreign key;
   - widening a `CHECK ... IN (...)` drops and re-adds it by its name
     (PostgreSQL names it `<table>_<column>_check`), as the access log
     and scope kind migrations do;
   - a column added to a table with rows is nullable or has a default.
5. **Queries**: runtime `sqlx::query` (D-049); every new or changed query
   is covered by an integration test in `server/tests/` (`#[sqlx::test]`
   applies all migrations to a fresh database).
6. **Verify** (`verify-changes`): `mise run db:up`, then `mise run check:rust`.
   Also start `mise run dev:server` once on the existing development
   database, which applies the migration to data the tests never had.
