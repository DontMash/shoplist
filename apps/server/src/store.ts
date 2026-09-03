import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import SQLiteDatabase from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import * as schema from './db/schema.js';

export type ItemId = string;

export interface ShoppingItem {
  id: ItemId;
  name: string;
  amount: string;
  collected: boolean;
  createdAt: number;
  updatedAt: number;
  by: string | null;
}

export interface Member {
  clientId: string;
  name: string;
  color: string;
  joinedAt: number;
}

export interface ShoppingList {
  id: string;
  name: string;
  ownerToken: string;
  createdAt: number;
  clearedAt: number | null;
  /** Monotonically increasing revision of accepted list mutations. */
  revision: number;
  items: ShoppingItem[];
  members: Record<string, Member>;
}

export type OperationKind =
  | 'item:add'
  | 'item:update'
  | 'item:delete'
  | 'list:clear'
  | 'list:rename'
  | 'list:delete';

const OPERATION_KINDS: OperationKind[] = [
  'item:add', 'item:update', 'item:delete', 'list:clear', 'list:rename', 'list:delete',
];
const LIST_ID = /^[A-Za-z0-9_-]{4,40}$/;

export interface StoreOperation {
  operationId: string;
  kind: OperationKind;
  payload: Record<string, unknown>;
  actorClientId: string | null;
}

export interface OperationAck {
  t: 'ack';
  opId: string;
  status: 'accepted' | 'rejected';
  revision: number;
  reason?: string;
  reasonCode?: string;
  message?: string;
  item?: ShoppingItem;
  tempItemId?: string;
  itemId?: string;
  idMap?: { tempId: string; itemId: string };
}

export interface OperationResult {
  ack: OperationAck;
  list: ShoppingList | null;
  duplicate: boolean;
  terminal: boolean;
}

/**
 * A compatibility view of the database used by the realtime layer. The
 * source of truth is SQLite; this object is a small in-memory read cache so
 * websocket broadcasts do not need to rebuild a list for every client.
 */
interface StoreSnapshot {
  lists: Record<string, ShoppingList>;
}

export interface ItemPatch {
  name?: unknown;
  amount?: unknown;
  collected?: unknown;
}

export interface NewItem {
  name?: unknown;
  amount?: unknown;
}

export const rid = (bytes = 9): string => crypto.randomBytes(bytes).toString('base64url');

/** Strip control chars, trim, and cap a user-provided string. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'ascii');

/**
 * SQLite-backed persistence using Drizzle's better-sqlite3 adapter.
 *
 * Writes are committed synchronously by SQLite, which is a better fit for the
 * websocket operation stream than debounced JSON serialization. The old JSON
 * store is detected and imported once (including the old `shopped` migration)
 * so existing self-hosted installations do not lose their lists.
 */
export class Store {
  /** In-memory projection used by the realtime layer; SQLite remains canonical. */
  private data: StoreSnapshot = { lists: {} };
  public readonly file: string;
  private readonly sqlite: SQLiteDatabase.Database;
  private readonly db: BetterSQLite3Database<typeof schema>;
  private closed = false;

  public constructor(file: string) {
    this.file = file;
    const legacy = this.prepareDatabaseFile(file);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sqlite = new SQLiteDatabase(file);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('journal_mode = WAL');
    this.db = drizzle(this.sqlite, { schema });
    this.initializeSchema();

    if (legacy) this.importLegacy(legacy);
    this.cleanupProcessedOperations();
    this.load();
  }

  /**
   * Operation outcomes are retained indefinitely. A list session can remain
   * open across an arbitrarily long outage, including after a list deletion,
   * so time-based pruning would make a replay unsafe. The processed table is
   * intentionally the durable replay window; a future bounded policy must be
   * paired with a maximum live-session lifetime.
   */
  private cleanupProcessedOperations(): void {
    // Deliberately empty: indefinite retention is the current replay policy.
  }

  /** Reload the in-memory compatibility view from the Drizzle tables. */
  public load(): void {
    const listRows = this.db.select().from(schema.lists).all();
    const itemRows = this.db.select().from(schema.items).all();
    const memberRows = this.db.select().from(schema.members).all();
    const itemsByList = new Map<string, ShoppingItem[]>();
    const membersByList = new Map<string, Record<string, Member>>();

    for (const row of itemRows) {
      const listItems = itemsByList.get(row.listId) || [];
      listItems.push({
        id: row.id,
        name: row.name,
        amount: row.amount,
        collected: Boolean(row.collected),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        by: row.by ?? null,
      });
      itemsByList.set(row.listId, listItems);
    }

    for (const row of memberRows) {
      const listMembers = membersByList.get(row.listId) || {};
      listMembers[row.clientId] = {
        clientId: row.clientId,
        name: row.name,
        color: row.color,
        joinedAt: row.joinedAt,
      };
      membersByList.set(row.listId, listMembers);
    }

    const lists: Record<string, ShoppingList> = {};
    for (const row of listRows) {
      lists[row.id] = {
        id: row.id,
        name: row.name,
        ownerToken: row.ownerToken,
        createdAt: row.createdAt,
        clearedAt: row.clearedAt ?? null,
        revision: row.revision ?? 0,
        items: itemsByList.get(row.id) || [],
        members: membersByList.get(row.id) || {},
      };
    }
    this.data = { lists };
  }

  public listCount(): number {
    return Object.keys(this.data.lists).length;
  }

  public flushSync(): void {
    if (this.closed) return;
    try {
      this.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[store] checkpoint failed:', message);
    }
  }

  public close(): void {
    if (this.closed) return;
    this.flushSync();
    this.sqlite.close();
    this.closed = true;
  }

  // ------------------------------------------------------------- lists

  public createList(name: unknown): ShoppingList {
    const now = Date.now();
    const list: ShoppingList = {
      id: rid(9),
      name: cleanText(name, 60) || 'Shopping list',
      ownerToken: rid(12),
      createdAt: now,
      clearedAt: null,
      revision: 0,
      items: [],
      members: {},
    };

    this.db.insert(schema.lists).values({
      id: list.id,
      name: list.name,
      ownerToken: list.ownerToken,
      createdAt: list.createdAt,
      clearedAt: list.clearedAt,
    }).run();
    this.data.lists[list.id] = list;
    return list;
  }

  public getList(id: string | undefined): ShoppingList | null {
    return (id && this.data.lists[id]) || null;
  }

  public deleteList(id: string): boolean {
    if (!this.data.lists[id]) return false;
    const result = this.db.delete(schema.lists).where(eq(schema.lists.id, id)).run();
    if (result.changes === 0) return false;
    delete this.data.lists[id];
    return true;
  }

  public renameList(list: ShoppingList, name: unknown): boolean {
    const clean = cleanText(name, 60);
    if (!clean) return false;
    const result = this.db.update(schema.lists)
      .set({ name: clean })
      .where(eq(schema.lists.id, list.id))
      .run();
    if (result.changes === 0) return false;
    list.name = clean;
    return true;
  }

  public clearList(list: ShoppingList): void {
    const clearedAt = Date.now();
    this.db.transaction((tx) => {
      tx.delete(schema.items).where(eq(schema.items.listId, list.id)).run();
      tx.update(schema.lists)
        .set({ clearedAt })
        .where(eq(schema.lists.id, list.id))
        .run();
    });
    list.items = [];
    list.clearedAt = clearedAt;
  }

  public touchMember(list: ShoppingList, clientId: string, name: string, color: string): void {
    const existing = list.members[clientId];
    const cleanName = cleanText(name, 40) || 'Guest';
    const member = {
      listId: list.id,
      clientId,
      name: cleanName,
      color,
      joinedAt: existing?.joinedAt || Date.now(),
    };

    this.db.insert(schema.members)
      .values(member)
      .onConflictDoUpdate({
        target: [schema.members.listId, schema.members.clientId],
        set: { name: member.name, color: member.color },
      })
      .run();
    list.members[clientId] = {
      clientId,
      name: member.name,
      color: member.color,
      joinedAt: member.joinedAt,
    };
  }

  public memberCount(list: ShoppingList): number {
    return Object.keys(list.members || {}).length;
  }

  // ------------------------------------------------------------- items

  public addItem(list: ShoppingList, { name, amount }: NewItem, by: string | null): ShoppingItem | null {
    const cleanName = cleanText(name, 80);
    if (!cleanName) return null;
    const now = Date.now();
    const item: ShoppingItem = {
      id: rid(8),
      name: cleanName,
      amount: cleanText(amount, 40),
      collected: false,
      createdAt: now,
      updatedAt: now,
      by: by || null,
    };

    this.db.insert(schema.items).values({
      id: item.id,
      listId: list.id,
      name: item.name,
      amount: item.amount,
      collected: item.collected,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      by: item.by,
    }).run();
    list.items.push(item);
    return item;
  }

  public updateItem(list: ShoppingList, itemId: string, patch: ItemPatch): boolean {
    const item = list.items.find((candidate) => candidate.id === itemId);
    if (!item) return false;

    const values: Partial<typeof schema.items.$inferInsert> = { updatedAt: Date.now() };
    if (patch.name !== undefined) {
      const clean = cleanText(patch.name, 80);
      if (!clean) return false; // an item always keeps a name
      values.name = clean;
    }
    if (patch.amount !== undefined) values.amount = cleanText(patch.amount, 40);
    if (patch.collected !== undefined) values.collected = Boolean(patch.collected);

    const result = this.db.update(schema.items)
      .set(values)
      .where(and(eq(schema.items.id, itemId), eq(schema.items.listId, list.id)))
      .run();
    if (result.changes === 0) return false;

    if (values.name !== undefined) item.name = values.name;
    if (values.amount !== undefined) item.amount = values.amount;
    if (values.collected !== undefined) item.collected = values.collected;
    item.updatedAt = values.updatedAt as number;
    return true;
  }

  public deleteItem(list: ShoppingList, itemId: string): boolean {
    const result = this.db.delete(schema.items)
      .where(and(eq(schema.items.id, itemId), eq(schema.items.listId, list.id)))
      .run();
    if (result.changes === 0) return false;
    const index = list.items.findIndex((item) => item.id === itemId);
    if (index !== -1) list.items.splice(index, 1);
    return true;
  }

  // ------------------------------------------------------------- operation stream

  /**
   * Apply one idempotent websocket operation. The list mutation, revision, and
   * original acknowledgement are committed in one SQLite transaction.
   */
  public applyOperation(listId: string, operation: StoreOperation): OperationResult {
    const current = this.getList(listId);
    const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
    if (operationId) {
      const stored = this.db.select().from(schema.processedOperations)
        .where(and(
          eq(schema.processedOperations.listId, listId),
          eq(schema.processedOperations.operationId, operationId),
        )).get();
      if (stored) {
        return {
          ack: JSON.parse(stored.responseJson) as OperationAck,
          list: this.getList(listId),
          duplicate: true,
          terminal: Boolean(stored.terminal),
        };
      }
    }
    if (!operationId || operationId.length > 160) {
      const safeOperation = { ...operation, operationId } as StoreOperation;
      const ack = rejected(safeOperation, current?.revision ?? 0, 'operation-too-large', 'The operation ID is invalid.');
      if (operationId) {
        this.db.insert(schema.processedOperations).values({
          listId,
          operationId,
          status: ack.status,
          revision: ack.revision,
          responseJson: JSON.stringify(ack),
          terminal: false,
          processedAt: Date.now(),
        }).run();
      }
      return { ack, list: current, duplicate: false, terminal: false };
    }

    if (!OPERATION_KINDS.includes(operation.kind) || !isRecordValue(operation.payload)) {
      const ack = rejected(operation, current?.revision ?? 0, 'invalid-operation', 'The operation is not supported.');
      this.db.insert(schema.processedOperations).values({
        listId,
        operationId: operation.operationId,
        status: ack.status,
        revision: ack.revision,
        responseJson: JSON.stringify(ack),
        terminal: false,
        processedAt: Date.now(),
      }).run();
      return { ack, list: current, duplicate: false, terminal: false };
    }

    const now = Date.now();
    const result = this.db.transaction((tx) => {
      const list = current;
      const revision = list?.revision ?? 0;
      let ack: OperationAck;
      let terminal = false;
      let accepted = false;
      let changedItem: ShoppingItem | null = null;
      let deletedItemId: string | null = null;
      let clearAt: number | null = null;
      let renamedTo: string | null = null;

      if (!list) {
        ack = {
          t: 'ack', opId: operation.operationId, status: 'rejected',
          revision, reason: 'list-not-found', reasonCode: 'list-not-found',
          message: 'The list no longer exists.',
        };
      } else {
        switch (operation.kind) {
          case 'item:add': {
            const itemPayload = isRecordValue(operation.payload.item) ? operation.payload.item : operation.payload;
            if (itemPayload.name !== undefined && typeof itemPayload.name !== 'string') {
              ack = rejected(operation, revision, 'invalid-payload', 'The item name is invalid.');
              break;
            }
            if (itemPayload.amount !== undefined && typeof itemPayload.amount !== 'string') {
              ack = rejected(operation, revision, 'invalid-payload', 'The item amount is invalid.');
              break;
            }
            const name = cleanText(itemPayload.name, 80);
            if (!name) {
              ack = rejected(operation, revision, 'name-required', 'An item needs a name.');
              break;
            }
            const item: ShoppingItem = {
              id: rid(8),
              name,
              amount: cleanText(itemPayload.amount, 40),
              collected: false,
              createdAt: now,
              updatedAt: now,
              by: operation.actorClientId || null,
            };
            const nextRevision = revision + 1;
            tx.insert(schema.items).values({
              id: item.id, listId, name: item.name, amount: item.amount,
              collected: item.collected, createdAt: item.createdAt,
              updatedAt: item.updatedAt, by: item.by,
            }).run();
            ack = {
              t: 'ack', opId: operation.operationId, status: 'accepted',
              revision: nextRevision, item, itemId: item.id,
              tempItemId: stringValue(itemPayload.tempItemId) || stringValue(itemPayload.tempId),
              idMap: stringValue(itemPayload.tempItemId) || stringValue(itemPayload.tempId)
                ? { tempId: (stringValue(itemPayload.tempItemId) || stringValue(itemPayload.tempId)) as string, itemId: item.id }
                : undefined,
            };
            accepted = true;
            changedItem = item;
            break;
          }

          case 'item:update': {
            const itemId = stringValue(operation.payload.id);
            const item = itemId ? list.items.find((candidate) => candidate.id === itemId) : undefined;
            const patchValue = operation.payload.patch;
            if (!item || !isRecordValue(patchValue)) {
              ack = rejected(operation, revision, 'item-not-found', 'The item no longer exists.');
              break;
            }
            const patch: ItemPatch = {};
            if ('name' in patchValue) patch.name = patchValue.name;
            if ('amount' in patchValue) patch.amount = patchValue.amount;
            if ('collected' in patchValue) patch.collected = patchValue.collected;
            if (patch.name !== undefined && typeof patch.name !== 'string') {
              ack = rejected(operation, revision, 'invalid-payload', 'The item name is invalid.');
              break;
            }
            if (patch.amount !== undefined && typeof patch.amount !== 'string') {
              ack = rejected(operation, revision, 'invalid-payload', 'The item amount is invalid.');
              break;
            }
            if (patch.collected !== undefined && typeof patch.collected !== 'boolean') {
              ack = rejected(operation, revision, 'invalid-payload', 'The collected state is invalid.');
              break;
            }
            const values: Partial<typeof schema.items.$inferInsert> = { updatedAt: now };
            if (patch.name !== undefined) {
              const clean = cleanText(patch.name, 80);
              if (!clean) {
                ack = rejected(operation, revision, 'name-required', 'An item needs a name.');
                break;
              }
              values.name = clean;
            }
            if (patch.amount !== undefined) values.amount = cleanText(patch.amount, 40);
            if (patch.collected !== undefined) values.collected = Boolean(patch.collected);
            if (Object.keys(values).length === 1) {
              ack = rejected(operation, revision, 'invalid-payload', 'No item fields were supplied.');
              break;
            }
            tx.update(schema.items).set(values)
              .where(and(eq(schema.items.id, item.id), eq(schema.items.listId, listId))).run();
            changedItem = { ...item };
            if (values.name !== undefined) changedItem.name = values.name;
            if (values.amount !== undefined) changedItem.amount = values.amount;
            if (values.collected !== undefined) changedItem.collected = values.collected;
            changedItem.updatedAt = now;
            ack = {
              t: 'ack', opId: operation.operationId, status: 'accepted',
              revision: revision + 1, itemId: item.id,
            };
            accepted = true;
            break;
          }

          case 'item:delete': {
            const itemId = stringValue(operation.payload.id);
            const item = itemId ? list.items.find((candidate) => candidate.id === itemId) : undefined;
            if (!item) {
              ack = rejected(operation, revision, 'item-not-found', 'The item no longer exists.');
              break;
            }
            tx.delete(schema.items).where(and(eq(schema.items.id, item.id), eq(schema.items.listId, listId))).run();
            ack = {
              t: 'ack', opId: operation.operationId, status: 'accepted', revision: revision + 1,
              itemId: item.id,
            };
            accepted = true;
            deletedItemId = item.id;
            break;
          }

          case 'list:clear':
            clearAt = now;
            tx.delete(schema.items).where(eq(schema.items.listId, listId)).run();
            tx.update(schema.lists).set({ clearedAt: clearAt, revision: revision + 1 })
              .where(eq(schema.lists.id, listId)).run();
            ack = { t: 'ack', opId: operation.operationId, status: 'accepted', revision: revision + 1 };
            accepted = true;
            break;

          case 'list:rename': {
            if (operation.payload.name !== undefined && typeof operation.payload.name !== 'string') {
              ack = rejected(operation, revision, 'invalid-payload', 'The list name is invalid.');
              break;
            }
            const name = cleanText(operation.payload.name, 60);
            if (!name) {
              ack = rejected(operation, revision, 'name-required', 'Give the list a name.');
              break;
            }
            tx.update(schema.lists).set({ name, revision: revision + 1 })
              .where(eq(schema.lists.id, listId)).run();
            ack = { t: 'ack', opId: operation.operationId, status: 'accepted', revision: revision + 1 };
            accepted = true;
            renamedTo = name;
            break;
          }

          case 'list:delete':
            if (stringValue(operation.payload.ownerToken) !== list.ownerToken) {
              ack = rejected(operation, revision, 'not-owner', 'Only the list owner can delete it.');
              break;
            }
            // The outcome is intentionally not foreign-keyed to lists. It must
            // remain replayable after the list row and its children disappear.
            ack = { t: 'ack', opId: operation.operationId, status: 'accepted', revision: revision + 1 };
            tx.delete(schema.lists).where(eq(schema.lists.id, listId)).run();
            accepted = true;
            terminal = true;
            break;
        }
      }

      if (list && accepted && operation.kind !== 'list:clear' && operation.kind !== 'list:rename' && operation.kind !== 'list:delete') {
        tx.update(schema.lists).set({ revision: revision + 1 }).where(eq(schema.lists.id, listId)).run();
      }
      tx.insert(schema.processedOperations).values({
        listId,
        operationId: operation.operationId,
        status: ack.status,
        revision: ack.revision,
        responseJson: JSON.stringify(ack),
        terminal,
        processedAt: now,
      }).run();
      return { ack, accepted, terminal, changedItem, deletedItemId, clearAt, renamedTo };
    });

    // Only update the compatibility projection after the transaction commits.
    if (current && result.accepted) {
      if (operation.kind === 'list:delete') {
        delete this.data.lists[listId];
      } else {
        current.revision = result.ack.revision;
        if (result.changedItem) {
          const index = current.items.findIndex((item) => item.id === result.changedItem!.id);
          if (index === -1) current.items.push(result.changedItem);
          else current.items[index] = result.changedItem;
        }
        if (result.deletedItemId) current.items = current.items.filter((item) => item.id !== result.deletedItemId);
        if (result.clearAt !== null) {
          current.items = [];
          current.clearedAt = result.clearAt;
        }
        if (result.renamedTo !== null) current.name = result.renamedTo;
      }
    }
    return {
      ack: result.ack,
      list: this.getList(listId),
      duplicate: false,
      terminal: result.terminal,
    };
  }

  // ------------------------------------------------------------- setup/migration

  private initializeSchema(): void {
    // DDL is intentionally kept next to the Store so a deployment does not
    // need a separate migration process just to boot an empty database. Use
    // Drizzle's raw SQL runner here as well as for all CRUD below.
    const statements = [
      `CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        cleared_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY NOT NULL,
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        amount TEXT NOT NULL DEFAULT '',
        collected INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        by TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS items_list_id_idx ON items(list_id)',
      `CREATE TABLE IF NOT EXISTS members (
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (list_id, client_id)
      )`,
      `CREATE TABLE IF NOT EXISTS processed_operations (
        list_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
        revision INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0,
        processed_at INTEGER NOT NULL,
        PRIMARY KEY (list_id, operation_id)
      )`,
      'CREATE INDEX IF NOT EXISTS processed_operations_processed_at_idx ON processed_operations(processed_at)',
    ];
    for (const statement of statements) this.db.run(statement);

    // CREATE TABLE IF NOT EXISTS does not migrate installations created by an
    // older release. Existing lists begin at revision zero.
    const columns = this.sqlite.prepare('PRAGMA table_info(lists)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'revision')) {
      this.sqlite.exec('ALTER TABLE lists ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
    }
    const processedColumns = this.sqlite.prepare('PRAGMA table_info(processed_operations)').all() as Array<{ name: string }>;
    if (!processedColumns.some((column) => column.name === 'terminal')) {
      this.sqlite.exec('ALTER TABLE processed_operations ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0');
    }
  }

  private importLegacy(legacy: StoreSnapshot): void {
    this.db.transaction((tx) => {
      for (const [key, source] of Object.entries(legacy.lists || {})) {
        if (!isRecordValue(source)) continue;
        const raw = source as Partial<ShoppingList>;
        const sourceId = typeof raw.id === 'string' ? cleanText(raw.id, 40) : '';
        const fallbackId = cleanText(key, 40);
        const id = LIST_ID.test(sourceId) ? sourceId : LIST_ID.test(fallbackId) ? fallbackId : rid(9);
        const list: ShoppingList = {
          id,
          name: cleanText(raw.name, 60) || 'Shopping list',
          ownerToken: cleanText(raw.ownerToken, 120) || rid(12),
          createdAt: numberOr(raw.createdAt, Date.now()),
          clearedAt: raw.clearedAt == null ? null : numberOr(raw.clearedAt, Date.now()),
          revision: 0,
          items: [],
          members: {},
        };

        const insertedList = tx.insert(schema.lists).values({
          id: list.id,
          name: list.name,
          ownerToken: list.ownerToken,
          createdAt: list.createdAt,
          clearedAt: list.clearedAt,
        }).onConflictDoNothing().run();
        if (insertedList.changes === 0) continue;

        for (const sourceItem of Array.isArray(raw.items) ? raw.items : []) {
          if (!isRecordValue(sourceItem)) continue;
          const item = sourceItem as Partial<ShoppingItem> & { shopped?: unknown };
          const itemId = cleanText(item.id, 80) || rid(8);
          const itemName = cleanText(item.name, 80);
          if (!itemName) continue;
          tx.insert(schema.items).values({
            id: itemId,
            listId: list.id,
            name: itemName,
            amount: cleanText(item.amount, 40),
            // Legacy `shopped` was a separate status and must not affect
            // collection. Only the old collected flag is retained.
            collected: item.collected === true || (item.collected as unknown) === 1,
            createdAt: numberOr(item.createdAt, Date.now()),
            updatedAt: numberOr(item.updatedAt, numberOr(item.createdAt, Date.now())),
            by: typeof item.by === 'string' ? cleanText(item.by, 80) || null : null,
          }).onConflictDoNothing().run();
        }

        const sourceMembers = isRecordValue(raw.members) ? raw.members : {};
        for (const [clientId, sourceMember] of Object.entries(sourceMembers)) {
          if (!isRecordValue(sourceMember)) continue;
          const member = sourceMember as Partial<Member>;
          const cleanClientId = cleanText(member.clientId || clientId, 80);
          if (!cleanClientId) continue;
          tx.insert(schema.members).values({
            listId: list.id,
            clientId: cleanClientId,
            name: cleanText(member.name, 40) || 'Guest',
            color: cleanText(member.color, 20) || '#888888',
            joinedAt: numberOr(member.joinedAt, Date.now()),
          }).onConflictDoNothing().run();
        }
      }
    });
  }

  /** Find and preserve the JSON file used by releases before the SQLite store. */
  private prepareDatabaseFile(file: string): StoreSnapshot | null {
    const candidates = [file];
    if (file.endsWith('.sqlite')) candidates.push(file.slice(0, -'.sqlite'.length) + '.json');

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate);
      if (raw.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
        // A few early deployments used the JSON filename for SQLite. If the
        // new .sqlite target is absent, retain that database in place rather
        // than silently starting with an empty store.
        if (candidate !== file && !fs.existsSync(file)) fs.renameSync(candidate, file);
        continue;
      }

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        // Preserve an invalid old file too; the new database can still boot.
      }
      const legacy = isDatabase(parsed) ? parsed : null;
      const backup = `${candidate}.legacy-${Date.now()}`;
      fs.renameSync(candidate, backup);
      return legacy;
    }
    return null;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rejected(operation: StoreOperation, revision: number, reason: string, message: string): OperationAck {
  return {
    t: 'ack', opId: operation.operationId, status: 'rejected', revision,
    reason, reasonCode: reason, message,
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isDatabase(value: unknown): value is StoreSnapshot {
  return Boolean(value && typeof value === 'object' && 'lists' in value &&
    value.lists && typeof value.lists === 'object' && !Array.isArray(value.lists));
}
