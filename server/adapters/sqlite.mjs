/**
 * SQLite adapter.
 *
 * Browsing uses a connection opened `readOnly` with `PRAGMA query_only = 1`;
 * a writable handle is opened lazily and only ever touched by `mutate`. Rows
 * carry an opaque row key so the UI can address a row without knowing whether
 * it is keyed by rowid or by a composite primary key.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  bindableValue,
  coerceForAffinity,
  columnAffinity,
  isBinaryType,
  likePattern,
  quoteIdent,
  toJsonValue,
} from '../util.mjs';

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;
const INTERNAL = /^sqlite_/;

export class SqliteAdapter {
  static kind = 'sqlite';

  constructor(filePath) {
    this.kind = SqliteAdapter.kind;
    this.path = filePath;
    this._ro = null;
    this._rw = null;
  }

  #openReadOnly() {
    // A WAL database needs write access to the -shm file even for reads, so
    // fall back to a read-write handle pinned with `query_only`.
    try {
      const db = new DatabaseSync(this.path, { readOnly: true });
      db.exec('PRAGMA query_only = 1');
      return { db, restricted: true };
    } catch (err) {
      try {
        const db = new DatabaseSync(this.path);
        db.exec('PRAGMA query_only = 1');
        return { db, restricted: true, note: err.message };
      } catch {
        throw err;
      }
    }
  }

  get reader() {
    if (!this._ro) this._ro = this.#openReadOnly().db;
    return this._ro;
  }

  get writer() {
    if (!this._rw) {
      this._rw = new DatabaseSync(this.path);
      this._rw.exec('PRAGMA foreign_keys = ON');
    }
    return this._rw;
  }

  /**
   * Reads of app metadata (pragmas, counts, DDL). These stay as plain numbers
   * — `setReadBigInts` would turn every flag into a BigInt, which silently
   * breaks `flag === 1` checks and makes sort comparators throw.
   */
  #meta(sql, params = []) {
    return this.reader.prepare(sql).all(...params);
  }

  #metaOne(sql, params = []) {
    const rows = this.#meta(sql, params);
    return rows.length ? rows[0] : undefined;
  }

  #all(sql, params = []) {
    const stmt = this.reader.prepare(sql);
    // Data reads keep integers exact; `toJsonValue` narrows them back to
    // numbers when they fit.
    stmt.setReadBigInts(true);
    return stmt.all(...params);
  }

  #one(sql, params = []) {
    const rows = this.#all(sql, params);
    return rows.length ? rows[0] : undefined;
  }

  #tableList() {
    return this.#meta('PRAGMA table_list')
      .filter((r) => r.schema === 'main' && !INTERNAL.test(r.name))
      .filter((r) => r.type === 'table' || r.type === 'view');
  }

  #describe(name) {
    const entry = this.#tableList().find((r) => r.name === name);
    if (!entry) {
      const err = new Error(`No such table or view: ${name}`);
      err.status = 404;
      throw err;
    }

    const info = this.#meta(`PRAGMA table_info(${quoteIdent(name)})`);
    const columns = info.map((c) => ({
      name: c.name,
      type: c.type || '',
      affinity: columnAffinity(c.type),
      nullable: c.notnull === 0,
      pk: c.pk > 0,
      pkPosition: c.pk,
      default: toJsonValue(c.dflt_value),
      binary: isBinaryType(c.type),
    }));

    // `rowid` is shadowed when a real column claims one of these names.
    const shadowsRowid = columns.some((c) => /^(rowid|_rowid_|oid)$/i.test(c.name));
    const pkColumns = columns
      .filter((c) => c.pk)
      .sort((a, b) => a.pkPosition - b.pkPosition)
      .map((c) => c.name);

    let rowIdentity = 'none';
    if (entry.type === 'table') {
      if (entry.wr === 1) rowIdentity = pkColumns.length ? 'pk' : 'none';
      else if (shadowsRowid) rowIdentity = pkColumns.length ? 'pk' : 'none';
      else rowIdentity = 'rowid';
    }

    return { entry, columns, pkColumns, rowIdentity, editable: rowIdentity !== 'none' };
  }

  #decodeKey(rowKey) {
    try {
      return JSON.parse(rowKey);
    } catch {
      const err = new Error('Malformed row key.');
      err.status = 400;
      throw err;
    }
  }

  #whereClause(desc, rowKey) {
    const key = this.#decodeKey(rowKey);
    if (desc.rowIdentity === 'rowid' && key[0] === 'r') {
      return { sql: 'rowid = ?', params: [bindableValue('INTEGER', key[1])] };
    }
    if (desc.rowIdentity === 'pk' && key[0] === 'pk') {
      const values = key[1];
      if (!Array.isArray(values) || values.length !== desc.pkColumns.length) {
        const err = new Error('Row key does not match the primary key.');
        err.status = 400;
        throw err;
      }
      const affinities = desc.pkColumns.map(
        (name) => desc.columns.find((c) => c.name === name)?.affinity ?? 'NUMERIC',
      );
      return {
        sql: desc.pkColumns.map((c) => `${quoteIdent(c)} IS ?`).join(' AND '),
        params: values.map((v, i) => bindableValue(affinities[i], v)),
      };
    }
    const err = new Error('Row key does not match this table.');
    err.status = 400;
    throw err;
  }

  // ---------------------------------------------------------------- public API

  listObjects() {
    return this.#tableList().map((entry) => {
      const desc = this.#describe(entry.name);
      let rowCount = null;
      try {
        rowCount = this.#metaOne(`SELECT COUNT(*) AS n FROM ${quoteIdent(entry.name)}`)?.n ?? null;
      } catch {
        rowCount = null;
      }
      return {
        name: entry.name,
        type: entry.type,
        editable: desc.editable,
        rowCount,
        columns: desc.columns.length,
      };
    });
  }

  getSchema(name) {
    const desc = this.#describe(name);

    let indexes = [];
    try {
      indexes = this.#meta(`PRAGMA index_list(${quoteIdent(name)})`).map((idx) => ({
        name: idx.name,
        unique: idx.unique === 1,
        origin: idx.origin,
        partial: idx.partial === 1,
        columns: this.#meta(`PRAGMA index_info(${quoteIdent(idx.name)})`)
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name)
          .filter((c) => c !== null),
      }));
    } catch {
      indexes = [];
    }

    let foreignKeys = [];
    try {
      foreignKeys = this.#meta(`PRAGMA foreign_key_list(${quoteIdent(name)})`).map((fk) => ({
        column: fk.from,
        refTable: fk.table,
        refColumn: fk.to,
        onDelete: fk.on_delete,
        onUpdate: fk.on_update,
      }));
    } catch {
      foreignKeys = [];
    }

    const ddl = this.#metaOne(
      'SELECT sql FROM sqlite_master WHERE name = ? AND type IN (\'table\', \'view\')',
      [name],
    );

    return {
      name,
      type: desc.entry.type,
      editable: desc.editable,
      rowIdentity: desc.rowIdentity,
      pkColumns: desc.pkColumns,
      withoutRowid: desc.entry.wr === 1,
      columnCount: desc.columns.length,
      columns: desc.columns,
      indexes,
      foreignKeys,
      ddl: ddl ? ddl.sql : null,
      rowCount: this.#metaOne(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)?.n ?? null,
    };
  }

  getRows(name, { limit = DEFAULT_LIMIT, offset = 0, sort = null, dir = 'asc', q = null } = {}) {
    const desc = this.#describe(name);
    const size = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const skip = Math.max(0, Number(offset) || 0);

    const names = desc.columns.map((c) => c.name);
    const useRowid = desc.rowIdentity === 'rowid';

    let ridAlias = null;
    if (useRowid) {
      ridAlias = '__dl_rid';
      let n = 0;
      while (names.includes(ridAlias)) {
        n += 1;
        ridAlias = `__dl_rid_${n}`;
      }
    }

    const selectList = [
      ...(useRowid ? [`rowid AS ${quoteIdent(ridAlias)}`] : []),
      ...names.map((n) => quoteIdent(n)),
    ].join(', ');

    const where = [];
    const params = [];
    if (q !== null && q !== undefined && String(q) !== '') {
      const pattern = likePattern(q);
      where.push(
        `(${names.map((n) => `CAST(${quoteIdent(n)} AS TEXT) LIKE ? ESCAPE '\\'`).join(' OR ')})`,
      );
      for (let i = 0; i < names.length; i += 1) params.push(pattern);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    let orderSql = '';
    if (sort && names.includes(sort)) {
      orderSql = ` ORDER BY ${quoteIdent(sort)} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
    } else if (useRowid) {
      orderSql = ` ORDER BY rowid ASC`;
    }

    const total =
      this.#metaOne(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}${whereSql}`, params)?.n ?? 0;

    const raw = this.#all(
      `SELECT ${selectList} FROM ${quoteIdent(name)}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
      [...params, size, skip],
    );

    const columns = desc.columns.map((c) => ({
      name: c.name,
      type: c.type,
      affinity: c.affinity,
      nullable: c.nullable,
      pk: c.pk,
      binary: c.binary,
    }));

    const rows = [];
    const rowKeys = [];
    const pkIndexes = desc.pkColumns.map((c) => names.indexOf(c));

    for (const record of raw) {
      if (useRowid) {
        const rid = record[ridAlias];
        rows.push(names.map((n) => toJsonValue(record[n])));
        rowKeys.push(JSON.stringify(['r', toJsonValue(rid)]));
      } else {
        const values = names.map((n) => toJsonValue(record[n]));
        rows.push(values);
        if (desc.rowIdentity === 'pk') {
          rowKeys.push(JSON.stringify(['pk', pkIndexes.map((i) => values[i])]));
        }
      }
    }

    return {
      columns,
      rows,
      rowKeys: desc.rowIdentity === 'none' ? null : rowKeys,
      rowKeyKind: desc.rowIdentity,
      total,
      limit: size,
      offset: skip,
      truncated: skip + rows.length < total,
    };
  }

  query(sql, { limit = DEFAULT_LIMIT } = {}) {
    const size = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const stmt = this.reader.prepare(sql);
    stmt.setReadBigInts(true);
    const meta = stmt.columns();
    const raw = stmt.all();
    const rows = raw.slice(0, size).map((record) => meta.map((m) => toJsonValue(record[m.name])));

    return {
      columns: meta.map((m) => ({
        name: m.name,
        type: m.type || '',
        affinity: columnAffinity(m.type),
        nullable: true,
        pk: false,
        binary: isBinaryType(m.type),
      })),
      rows,
      rowKeys: null,
      rowKeyKind: 'none',
      total: raw.length,
      limit: size,
      offset: 0,
      truncated: raw.length > size,
    };
  }

  mutate(name, ops) {
    const desc = this.#describe(name);
    if (!desc.editable) {
      const err = new Error(`"${name}" is a ${desc.entry.type} without a primary key and is read-only.`);
      err.status = 400;
      throw err;
    }

    const byName = new Map(desc.columns.map((c) => [c.name, c]));
    const db = this.writer;
    const results = [];

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of ops) {
        if (op.op === 'update') {
          const column = byName.get(op.column);
          if (!column) {
            const err = new Error(`Unknown column: ${op.column}`);
            err.status = 400;
            throw err;
          }
          if (column.binary) {
            const err = new Error(`Column "${column.name}" holds binary data and cannot be edited here.`);
            err.status = 400;
            throw err;
          }
          const where = this.#whereClause(desc, op.rowKey);
          const stmt = db.prepare(
            `UPDATE ${quoteIdent(name)} SET ${quoteIdent(column.name)} = ? WHERE ${where.sql}`,
          );
          const info = stmt.run(coerceForAffinity(column.affinity, op.value), ...where.params);
          if (Number(info.changes) === 0) {
            const err = new Error('Row not found — it may have been changed or deleted elsewhere.');
            err.status = 409;
            throw err;
          }
          results.push({ op: 'update', changed: Number(info.changes) });
          continue;
        }

        if (op.op === 'delete') {
          const where = this.#whereClause(desc, op.rowKey);
          const stmt = db.prepare(`DELETE FROM ${quoteIdent(name)} WHERE ${where.sql}`);
          const info = stmt.run(...where.params);
          if (Number(info.changes) === 0) {
            const err = new Error('Row not found — it may have been changed or deleted elsewhere.');
            err.status = 409;
            throw err;
          }
          results.push({ op: 'delete', changed: Number(info.changes) });
          continue;
        }

        if (op.op === 'insert') {
          const entries = Object.entries(op.values ?? {});
          if (!entries.length) {
            const err = new Error('Nothing to insert.');
            err.status = 400;
            throw err;
          }
          for (const [key] of entries) {
            if (!byName.has(key)) {
              const err = new Error(`Unknown column: ${key}`);
              err.status = 400;
              throw err;
            }
          }
          const cols = entries.map(([k]) => quoteIdent(k)).join(', ');
          const marks = entries.map(() => '?').join(', ');
          const values = entries.map(([k, v]) => coerceForAffinity(byName.get(k).affinity, v));
          const info = db
            .prepare(`INSERT INTO ${quoteIdent(name)} (${cols}) VALUES (${marks})`)
            .run(...values);

          let rowKey = null;
          if (desc.rowIdentity === 'rowid') {
            rowKey = JSON.stringify(['r', Number(info.lastInsertRowid)]);
          } else if (desc.rowIdentity === 'pk') {
            const pkValues = desc.pkColumns.map((c) => {
              const supplied = op.values[c];
              return supplied === undefined ? null : toJsonValue(supplied);
            });
            rowKey = JSON.stringify(['pk', pkValues]);
          }
          results.push({ op: 'insert', rowKey });
          continue;
        }

        const err = new Error(`Unsupported operation: ${op.op}`);
        err.status = 400;
        throw err;
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      throw err;
    }

    return { applied: results.length, results };
  }

  close() {
    for (const key of ['_ro', '_rw']) {
      if (this[key]) {
        try {
          this[key].close();
        } catch {
          /* already closed */
        }
        this[key] = null;
      }
    }
  }
}
