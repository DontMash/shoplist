# Drizzle Kit owns SQLite schema migrations

**Status:** accepted

`apps/server/src/db/schema.ts` is the authoritative application schema. Drizzle Kit generates the committed migration history under `apps/server/migrations`, and the server applies it through Drizzle’s migrator at startup. Pre-journal SQLite databases are adopted by matching their catalog to the generated migration snapshots before the remaining migrations run, preserving existing SQLite data without embedding schema DDL in TypeScript. The former JSON store is not migrated; SQLite is the only supported persistence format.
