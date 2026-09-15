CREATE TABLE lists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE TABLE items (
  id TEXT PRIMARY KEY NOT NULL,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '',
  collected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  by TEXT
);
CREATE INDEX items_list_id_idx ON items(list_id);
CREATE TABLE members (
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, client_id)
);
INSERT INTO lists (id, name, owner_token, created_at) VALUES ('legacy', 'Legacy', 'owner', 1);
INSERT INTO items (id, list_id, name, created_at, updated_at, by)
  VALUES ('item', 'legacy', 'Bread', 1, 1, 'client-a');
INSERT INTO members (list_id, client_id, name, color, joined_at)
  VALUES ('legacy', 'client-a', 'Alice', '#123456', 1);
