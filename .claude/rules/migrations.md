---
paths:
  - "server/migrations/**"
---

# Migrations: traps

- An applied migration is never edited: sqlx checks its checksum on every start. A change is a new file.
- Every user-owned table references `users` with `ON DELETE CASCADE`: account deletion removes everything (D-039), and a table that does not cascade breaks that promise silently.
- Constraints the application relies on are in the schema (`CHECK`, `UNIQUE`, foreign keys), not only in Rust.
- Plaintext columns are metadata the threat model lists (docs/threat-model.md#metadata); a new plaintext column of user data updates that list.
