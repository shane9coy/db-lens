/**
 * App metadata store.
 *
 * This is DB Lens's own little database — the list of files you have opened,
 * when you last touched them, and whether writes are unlocked. It never holds
 * credentials: sources are addressed by local path only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  path         TEXT    NOT NULL UNIQUE,
  edit_enabled INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL,
  last_opened  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sources_last_opened ON sources (last_opened DESC);
`;

function rowToSource(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    kind: row.kind,
    path: row.path,
    editEnabled: row.edit_enabled === 1,
    createdAt: row.created_at,
    lastOpened: row.last_opened,
  };
}

export class Registry {
  #db;

  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  list() {
    return this.#db
      .prepare('SELECT * FROM sources ORDER BY last_opened DESC, id DESC')
      .all()
      .map(rowToSource);
  }

  get(id) {
    return rowToSource(this.#db.prepare('SELECT * FROM sources WHERE id = ?').get(Number(id)));
  }

  findByPath(filePath) {
    return rowToSource(this.#db.prepare('SELECT * FROM sources WHERE path = ?').get(filePath));
  }

  /** Insert or refresh a source, returning the stored record. */
  upsert({ name, kind, path: filePath }) {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO sources (name, kind, path, created_at, last_opened)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           last_opened = excluded.last_opened`,
      )
      .run(name, kind, filePath, now, now);
    return this.findByPath(filePath);
  }

  touch(id) {
    this.#db
      .prepare('UPDATE sources SET last_opened = ? WHERE id = ?')
      .run(new Date().toISOString(), Number(id));
  }

  setEditEnabled(id, enabled) {
    this.#db
      .prepare('UPDATE sources SET edit_enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Number(id));
    return this.get(id);
  }

  remove(id) {
    const info = this.#db.prepare('DELETE FROM sources WHERE id = ?').run(Number(id));
    return Number(info.changes) > 0;
  }

  close() {
    try {
      this.#db.close();
    } catch {
      /* already closed */
    }
  }
}
