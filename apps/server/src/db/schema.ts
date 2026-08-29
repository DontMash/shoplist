import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The durable shoplist schema.  Lists, items, and members are separate rows so
 * SQLite can enforce list ownership and cascade item/member cleanup when a
 * list is deleted.
 */
export const lists = sqliteTable('lists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ownerToken: text('owner_token').notNull(),
  createdAt: integer('created_at').notNull(),
  clearedAt: integer('cleared_at'),
  revision: integer('revision').notNull().default(0),
});

/** Durable operation outcomes make websocket replay idempotent across restarts. */
export const processedOperations = sqliteTable('processed_operations', {
  listId: text('list_id').notNull(),
  operationId: text('operation_id').notNull(),
  status: text('status').notNull(),
  revision: integer('revision').notNull(),
  responseJson: text('response_json').notNull(),
  terminal: integer('terminal', { mode: 'boolean' }).notNull().default(false),
  processedAt: integer('processed_at').notNull(),
}, (table) => [primaryKey({ columns: [table.listId, table.operationId] })]);

export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  listId: text('list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  amount: text('amount').notNull().default(''),
  collected: integer('collected', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  by: text('by'),
});

export const members = sqliteTable('members', {
  listId: text('list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  joinedAt: integer('joined_at').notNull(),
}, (table) => [primaryKey({ columns: [table.listId, table.clientId] })]);

