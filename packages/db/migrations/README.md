# migrations

SQL-first, checksummed, append-only. Naming: `NNNN_snake_name.up.sql` + optional
`NNNN_snake_name.down.sql`.

Rules (spec §18.2):

- One migration = one file pair; never edit an applied `.up.sql` (checksum gate fails CI).
- Reversible steps get a `.down.sql`; destructive/irreversible steps are declared by absence
  of a down file and `migrate down` refuses to cross them — use expand→migrate→contract.
- Every business PK defaults to `lanxu_uuidv7()` (defined in the first migration).
- Record lock risk + compat window in a header comment inside the SQL file.
