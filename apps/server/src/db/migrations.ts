import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Drizzle's bookkeeping table, kept out of the application schema generation. */
export const drizzleMigrations = sqliteTable('__drizzle_migrations', {
  id: integer('id').primaryKey(),
  hash: text('hash').notNull(),
  createdAt: integer('created_at'),
});

/** SQLite's catalog, queried through Drizzle during legacy-schema adoption. */
export const sqliteMaster = sqliteTable('sqlite_master', {
  type: text('type'),
  name: text('name'),
  tblName: text('tbl_name'),
  rootPage: integer('rootpage'),
  sql: text('sql'),
});
