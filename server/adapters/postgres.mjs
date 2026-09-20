/**
 * PostgreSQL adapter.
 *
 * The source target is a connection string rather than a path, so this is the
 * one adapter that is not file-backed. Browsing runs on a pool whose sessions
 * are opened `default_transaction_read_only` with a `statement_timeout`; a
 * separate pool is created lazily and only ever used by `mutate`.
 *
 * Postgres has no `rowid`, so a row is addressable only when its table has a
 * primary key. A table without one — including every view — is reported as
 * read-only, matching the rule the SQLite adapter applies.
 *
 * Objects are named `schema.table`, which keeps the UI's single-level object
 * list honest without hiding which schema a table lives in.
 */

import pgModule from 'pg';
import { coerceForAffinity, isBinaryType, likePattern, quoteIdent, toJsonValue } from '../util.mjs';

const PG = pgModule?.default ?? pgModule;
const { Pool, types } = PG;

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;
/**
 * Deliberately under the engine's 20s deadline: Postgres cancels the statement
 * and returns a readable error, which beats the host killing the worker.
 */
const DEFAULT_STATEMENT_TIMEOUT = 15_000;

/**
 * Every page fetch asks for the exact total, which is a full scan on the
 * server. Paging through one filtered result repeats that identical scan per
 * page, so it is memoised briefly. The TTL bounds staleness from other clients;
 * our own writes clear it outright.
 */
const COUNT_TTL_MS = 5000;
const COUNT_CACHE_MAX = 64;

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;
const TIME_OID = 1083;
const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const TIMETZ_OID = 1266;
const INTERVAL_OID = 1186;

/**
 * node-postgres hands back int8 and numeric as strings, which is the right
 * default for precision and the wrong one for a data grid: `1` would render as
 * text and refuse to align with other numbers. Narrow them where that loses
 * nothing, and leave anything longer alone so the exact digits survive.
 *
 * These parsers are process-wide for the pg module, which is fine here: the
 * adapter only ever runs inside its own worker thread.
 */
function parseExactInteger(text) {
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) ? numeric : text;
}

function parseNumeric(text) {
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  if (text.replace(/[-.]/g, '').replace(/^0+/, '').length > 15) return text;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : text;
}

types.setTypeParser(INT8_OID, parseExactInteger);
types.setTypeParser(NUMERIC_OID, parseNumeric);

// Temporal values keep their stored text. The default parsers build JS Dates,
// which are millisecond-precision: `timestamptz` loses microseconds on read and
// a save-through then writes the truncated instant back. `date` additionally
// becomes a zoned instant at local midnight, which can land on the wrong day,
// and `interval` becomes a `{days, hours, …}` object that renders as raw JSON.
for (const oid of [
  DATE_OID,
  TIME_OID,
  TIMESTAMP_OID,
  TIMESTAMPTZ_OID,
  TIMETZ_OID,
  INTERVAL_OID,
]) {
  types.setTypeParser(oid, (text) => text);
}

/** Map a Postgres type onto the affinity used for value coercion. */
function pgAffinity(baseType) {
  const type = String(baseType ?? '').toLowerCase();
  if (type === 'int2' || type === 'int4' || type === 'int8' || type === 'oid') return 'INTEGER';
  if (type === 'numeric' || type === 'float4' || type === 'float8' || type === 'money') return 'NUMERIC';
  if (type.startsWith('bool')) return 'TEXT';
  if (type === 'bytea') return 'BLOB';
  if (type === 'text' || type === 'varchar' || type === 'bpchar' || type === 'name') return 'TEXT';
  return 'TEXT';
}

/** pg accepts what the driver can serialise; BigInt has to become text. */
function toBindable(value) {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function pgStatus(err) {
  const code = err?.code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ECONNRESET'
  ) {
    // Not an internal fault: the server is unreachable, which the operator can
    // act on and which should not be logged as if the app had broken.
    return 503;
  }

  switch (code) {
    case '28P01': // invalid_password
    case '28000': // invalid_authorization_specification
    case '3D000': // invalid_catalog_name (database does not exist)
      return 400;
    case '42P01': // undefined_table
    case '3F000': // invalid_schema_name
      return 404;
    case '23505': // unique_violation
      return 409;
    case '23502': // not_null_violation
    case '23503': // foreign_key_violation
    case '22P02': // invalid_text_representation
      return 400;
    default:
      return 500;
  }
}

/** `schema.table`, tolerating a table name that itself contains dots. */
function splitObject(name) {
  const dot = name.indexOf('.');
  if (dot < 0) return { schema: null, table: name };
  return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
}

export class PostgresAdapter {
  static kind = 'postgres';

  #readPool = null;
  #writePool = null;
  #typeNames = null;
  #counts = new Map();
  #statementTimeout;

  async #countOf(key, compute) {
    const now = Date.now();
    const hit = this.#counts.get(key);
    if (hit && now - hit.at < COUNT_TTL_MS) return hit.total;

    const total = await compute();
    // Evict the oldest rather than clearing the map: a whole-map flush throws
    // away the entry for the object being paged, and reclaiming it costs a full
    // scan — orders of magnitude more than the entry it made room for.
    if (this.#counts.size >= COUNT_CACHE_MAX) {
      this.#counts.delete(this.#counts.keys().next().value);
    }
    this.#counts.set(key, { total, at: now });
    return total;
  }

  constructor(connectionString, { statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT } = {}) {
    if (!/^postgres(ql)?:\/\//i.test(String(connectionString ?? ''))) {
      const err = new Error('A PostgreSQL source needs a postgres:// connection string.');
      err.status = 400;
      throw err;
    }
    this.kind = PostgresAdapter.kind;
    /** For a network source this is the connection string, not a path. */
    this.path = connectionString;
    this.#statementTimeout = Math.max(1000, Math.floor(statementTimeoutMs));
  }

  // ----------------------------------------------------------------- pools

  get #read() {
    if (!this.#readPool) {
      this.#readPool = new Pool({
        connectionString: this.path,
        // One connection per source. The pool is per source and lives until the
        // source is dropped, so anything larger multiplies by the number of
        // saved databases — 25 sources at max 4 is 100 sockets, which is a
        // stock server's entire max_connections, and the failure mode is that
        // *every* client of that database is locked out.
        max: 1,
        application_name: 'db-lens',
        // A host that silently drops packets would otherwise hang forever.
        connectionTimeoutMillis: 10_000,
        // Belt and braces behind the SQL guard: nothing on this pool can write,
        // and no single statement can run away.
        options: `-c default_transaction_read_only=on -c statement_timeout=${this.#statementTimeout}`,
      });
      // A pool-level error would otherwise be an unhandled 'error' event.
      this.#readPool.on('error', () => {});
    }
    return this.#readPool;
  }

  get #write() {
    if (!this.#writePool) {
      this.#writePool = new Pool({
        connectionString: this.path,
        max: 1,
        application_name: 'db-lens',
        connectionTimeoutMillis: 10_000,
        options: `-c statement_timeout=${this.#statementTimeout}`,
      });
      this.#writePool.on('error', () => {});
    }
    return this.#writePool;
  }

  async #query(sql, params = [], pool = this.#read) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      const wrapped = new Error(err.message);
      wrapped.status = pgStatus(err);
      wrapped.code = err.code;
      throw wrapped;
    }
  }

  /** Resolve `schema.table` to an oid, and the columns that come with it. */
  async #resolve(name) {
    const { schema, table } = splitObject(name);
    const { rows } = await this.#query(
      `SELECT c.oid AS oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1
          AND ($2::text IS NULL OR n.nspname = $2)
          AND c.relkind IN ('r','p','f','v','m')
        ORDER BY (n.nspname = 'public') DESC, n.nspname
        LIMIT 1`,
      [table, schema],
    );

    if (!rows.length) {
      const err = new Error(`No such table or view: ${name}`);
      err.status = 404;
      throw err;
    }
    return rows[0];
  }

  async #describe(name) {
    const relation = await this.#resolve(name);
    const ref = `${quoteIdent(relation.schema)}.${quoteIdent(relation.name)}`;

    const [columns, primaryKey, indexes, foreignKeys] = await Promise.all([
      this.#query(
        `SELECT a.attname AS name,
                format_type(a.atttypid, a.atttypmod) AS type,
                t.typname AS base_type,
                NOT a.attnotnull AS nullable,
                a.attgenerated AS generated,
                -- pg_get_expr returns the default *expression*. Only a constant
                -- is a value a client can send back; publishing nextval(...) or
                -- now() would have the New-row dialog pre-fill and submit it.
                CASE WHEN a.attgenerated = '' AND left(d.adbin::text, 6) = '{CONST'
                     THEN pg_get_expr(d.adbin, d.adrelid)
                END AS default_value
           FROM pg_attribute a
           JOIN pg_type t ON t.oid = a.atttypid
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
        [relation.oid],
      ),
      // indkey holds the key columns followed by any INCLUDE columns, and
      // indnkeyatts is how many of them are actually the key.
      this.#query(
        `SELECT a.attname AS name
           FROM pg_index i
           JOIN pg_attribute a
             ON a.attrelid = i.indrelid
            AND a.attnum = ANY (i.indkey[0:i.indnkeyatts - 1])
          WHERE i.indrelid = $1 AND i.indisprimary
          ORDER BY array_position(i.indkey::int2[], a.attnum)`,
        [relation.oid],
      ),
      this.#query(
        `SELECT i.relname AS name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
                pg_get_indexdef(ix.indexrelid) AS definition
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = $1
          ORDER BY i.relname`,
        [relation.oid],
      ),
      this.#query(
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con
          WHERE con.conrelid = $1 AND con.contype = 'f'
          ORDER BY con.conname`,
        [relation.oid],
      ),
    ]);

    const pkColumns = primaryKey.rows.map((row) => row.name);
    const isTable = relation.kind === 'r' || relation.kind === 'p' || relation.kind === 'f';
    const editable = isTable && pkColumns.length > 0;

    return {
      relation,
      ref,
      pkColumns,
      editable,
      columns: columns.rows.map((row) => ({
        name: row.name,
        type: row.type,
        affinity: pgAffinity(row.base_type),
        nullable: row.nullable,
        pk: pkColumns.includes(row.name),
        binary: isBinaryType(row.base_type),
        // Postgres names an array type with a leading underscore. Arrays arrive
        // parsed, so the grid would render JSON while the server expects the
        // `{a,b}` literal — readable, but not safely writable. A generated
        // column can never be assigned at all.
        readonly: String(row.base_type ?? '').startsWith('_') || row.generated !== '',
        default: toJsonValue(row.default_value),
      })),
      indexes: indexes.rows.map((row) => ({
        name: row.name,
        unique: row.is_unique,
        origin: row.is_primary ? 'pk' : 'index',
        partial: false,
        columns: [],
        definition: row.definition,
      })),
      foreignKeys: foreignKeys.rows.map((row) => ({
        column: '',
        refTable: row.definition,
        refColumn: null,
        onDelete: '',
        onUpdate: '',
      })),
    };
  }

  // ---------------------------------------------------------------- public API

  async probe() {
    await this.#query('SELECT 1 AS ok');
    return true;
  }

  async listObjects() {
    const { rows } = await this.#query(
      `SELECT n.nspname AS schema,
              c.relname AS name,
              CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END AS type,
              GREATEST(c.reltuples, 0)::bigint AS estimate,
              (SELECT count(*) FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
              (c.relkind IN ('r','p','f') AND EXISTS (
                 SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary
               )) AS editable
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','f','v','m')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%'
          AND n.nspname NOT LIKE 'pg\\_temp%'
        ORDER BY n.nspname, c.relname`,
    );

    return rows.map((row) => ({
      name: `${row.schema}.${row.name}`,
      type: row.type,
      editable: row.editable,
      // reltuples is the planner's estimate: cheap on any size, refreshed by
      // ANALYZE. The exact count is shown once a table is actually opened.
      rowCount: Number(row.estimate),
      rowCountEstimated: true,
      columns: Number(row.columns),
    }));
  }

  async getSchema(name) {
    const described = await this.#describe(name);

    let viewDefinition = null;
    if (described.relation.kind === 'v' || described.relation.kind === 'm') {
      const { rows } = await this.#query(
        `SELECT pg_get_viewdef($1::oid, true) AS definition`,
        [described.relation.oid],
      );
      viewDefinition = rows[0]?.definition ?? null;
    }

    let rowCount = null;
    try {
      // Same key `getRows` uses for an unfiltered page, so opening a table and
      // then reading it pays for one count rather than two.
      rowCount = await this.#countOf(`${name}\u0000\u0000`, async () => {
        const { rows } = await this.#query(`SELECT count(*)::bigint AS n FROM ${described.ref}`);
        return parseExactInteger(String(rows[0].n));
      });
    } catch {
      rowCount = null;
    }

    return {
      name,
      type: described.relation.kind === 'v' || described.relation.kind === 'm' ? 'view' : 'table',
      editable: described.editable,
      rowIdentity: described.editable ? 'pk' : 'none',
      pkColumns: described.pkColumns,
      withoutRowid: false,
      columnCount: described.columns.length,
      columns: described.columns,
      indexes: described.indexes,
      foreignKeys: described.foreignKeys,
      ddl: viewDefinition,
      rowCount,
      rowCountEstimated: false,
    };
  }

  async getRows(name, { limit = DEFAULT_LIMIT, offset = 0, sort = null, dir = 'asc', q = null } = {}) {
    const described = await this.#describe(name);
    const size = Math.max(1, Math.min(Math.floor(Number(limit)) || DEFAULT_LIMIT, MAX_LIMIT));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const columns = described.columns.map((column) => ({
      name: column.name,
      type: column.type,
      affinity: column.affinity,
      nullable: column.nullable,
      pk: column.pk,
      binary: column.binary,
      readonly: column.readonly,
    }));

    const where = [];
    const params = [];
    if (q !== null && q !== undefined && String(q) !== '') {
      const pattern = likePattern(q);
      const predicates = columns.map((column) => {
        params.push(pattern);
        return `${quoteIdent(column.name)}::text ILIKE $${params.length} ESCAPE '\\'`;
      });
      where.push(`(${predicates.join(' OR ')})`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    // Postgres has no natural order, so paging without one can repeat or skip
    // rows. The primary key is the only stable choice available.
    let orderSql = '';
    if (sort && columns.some((column) => column.name === sort)) {
      const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      // Match SQLite, where NULL is the smallest value.
      orderSql = ` ORDER BY ${quoteIdent(sort)} ${direction} ${direction === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST'}`;
    } else if (described.pkColumns.length) {
      orderSql = ` ORDER BY ${described.pkColumns.map((c) => quoteIdent(c)).join(', ')}`;
    }

    const total = await this.#countOf(`${name}\u0000${whereSql}\u0000${q ?? ''}`, async () => {
      const countResult = await this.#query(
        `SELECT count(*)::bigint AS n FROM ${described.ref}${whereSql}`,
        params,
      );
      return parseExactInteger(String(countResult.rows[0].n));
    });

    const pageParams = [...params, size, skip];
    const { rows } = await this.#query(
      `SELECT * FROM ${described.ref}${whereSql}${orderSql} LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    );

    const pkIndexes = described.pkColumns.map((column) => columns.findIndex((c) => c.name === column));
    const projected = rows.map((row) => columns.map((column) => toJsonValue(row[column.name])));

    return {
      columns,
      rows: projected,
      rowKeys: described.editable
        ? projected.map((values) => JSON.stringify(['pk', pkIndexes.map((i) => values[i])]))
        : null,
      rowKeyKind: described.editable ? 'pk' : 'none',
      total,
      limit: size,
      offset: skip,
      truncated: skip + projected.length < total,
    };
  }

  /** Column type names for a set of oids, cached for the life of the adapter. */
  async #typeNameMap(oids) {
    if (!this.#typeNames) {
      const { rows } = await this.#query('SELECT oid, typname FROM pg_type');
      this.#typeNames = new Map(rows.map((row) => [Number(row.oid), row.typname]));
    }
    return oids.map((oid) => this.#typeNames.get(Number(oid)) ?? '');
  }

  /**
   * Run a guarded SELECT behind a cursor.
   *
   * A plain `client.query(sql)` would buffer the entire result set in the
   * worker before anything could cap it; a cursor fetches only the page asked
   * for and leaves the rest on the server.
   */
  async query(sql, { limit = DEFAULT_LIMIT } = {}) {
    const size = Math.max(1, Math.min(Math.floor(Number(limit)) || DEFAULT_LIMIT, MAX_LIMIT));
    const client = await this.#read.connect();
    let rows = [];
    let fields = [];

    try {
      await client.query('BEGIN READ ONLY');
      try {
        // Embedding the statement as a subquery makes "one statement" a
        // property of the dialect rather than something the guard has to get
        // right: a `;` inside the parentheses is a syntax error, not a second
        // command. The guard runs first and still reports the nicer message.
        await client.query(
          `DECLARE dblens_cursor NO SCROLL CURSOR FOR SELECT * FROM (${sql}) AS dblens_console`,
        );
        const fetched = await client.query({
          text: `FETCH FORWARD ${size + 1} FROM dblens_cursor`,
          // Positional rows: a projection with duplicate output names, which
          // the console invites (`SELECT c.id, o.id`), would otherwise collapse
          // to the last one and show a value from the wrong column.
          rowMode: 'array',
        });
        rows = fetched.rows;
        fields = fetched.fields;
        await client.query('CLOSE dblens_cursor');
      } finally {
        await client.query('ROLLBACK');
      }
    } catch (err) {
      const wrapped = new Error(err.message);
      wrapped.status = pgStatus(err);
      wrapped.code = err.code;
      throw wrapped;
    } finally {
      client.release();
    }

    const truncated = rows.length > size;
    const page = truncated ? rows.slice(0, size) : rows;
    const baseTypes = await this.#typeNameMap(fields.map((field) => field.dataTypeID));

    return {
      columns: fields.map((field, i) => ({
        name: field.name,
        type: baseTypes[i],
        affinity: pgAffinity(baseTypes[i]),
        nullable: true,
        pk: false,
        binary: isBinaryType(baseTypes[i]),
      })),
      rows: page.map((row) => row.map((value) => toJsonValue(value))),
      rowKeys: null,
      rowKeyKind: 'none',
      total: page.length,
      limit: size,
      offset: 0,
      truncated,
    };
  }

  async mutate(name, ops) {
    const described = await this.#describe(name);
    if (!described.editable) {
      const err = new Error(
        `"${name}" has no primary key, so a row cannot be addressed and it is read-only.`,
      );
      err.status = 400;
      throw err;
    }

    const byName = new Map(described.columns.map((column) => [column.name, column]));
    const badRequest = (message) => {
      const err = new Error(message);
      err.status = 400;
      return err;
    };
    const conflict = (message) => {
      const err = new Error(message);
      err.status = 409;
      return err;
    };

    // `offset` is how many placeholders the caller has already used, so the
    // key predicates continue the numbering rather than restarting at $1.
    const whereFor = (rowKey, offset) => {
      let key;
      try {
        key = JSON.parse(rowKey);
      } catch {
        key = null;
      }
      if (
        !Array.isArray(key) ||
        key[0] !== 'pk' ||
        !Array.isArray(key[1]) ||
        key[1].length !== described.pkColumns.length
      ) {
        throw badRequest('Row key does not match the primary key.');
      }
      const params = key[1].map((value) => toBindable(value));
      const sql = described.pkColumns
        .map(
          (column, i) =>
            `${quoteIdent(column)} IS NOT DISTINCT FROM $${offset + i + 1}`,
        )
        .join(' AND ');
      return { sql, params };
    };

    // Validate against the original row keys before opening a transaction, so a
    // batch that cannot be addressed never starts one.
    const plan = ops.map((op) => {
      if (op.op === 'update') {
        const column = byName.get(op.column);
        if (!column) throw badRequest(`Unknown column: ${op.column}`);
        if (column.binary) {
          throw badRequest(`Column "${column.name}" holds binary data and cannot be edited here.`);
        }
        if (column.readonly) {
          throw badRequest(`Column "${column.name}" is generated or an array and cannot be edited here.`);
        }
        return { kind: 'update', column, where: whereFor(op.rowKey, 1), value: op.value };
      }
      if (op.op === 'delete') {
        return { kind: 'delete', where: whereFor(op.rowKey, 0) };
      }
      if (op.op === 'insert') {
        const entries = Object.entries(op.values ?? {});
        if (!entries.length) throw badRequest('Nothing to insert.');
        for (const [key] of entries) {
          const column = byName.get(key);
          if (!column) throw badRequest(`Unknown column: ${key}`);
          // The same restrictions the update path applies. Without these the
          // insert path would accept the base64 text the reader produced for a
          // bytea column and store it as literal bytes.
          if (column.binary) {
            throw badRequest(`Column "${column.name}" holds binary data and cannot be edited here.`);
          }
          if (column.readonly) {
            throw badRequest(`Column "${column.name}" cannot be written here.`);
          }
        }
        return { kind: 'insert', entries };
      }
      throw badRequest(`Unsupported operation: ${op.op}`);
    });

    const client = await this.#write.connect();
    const results = [];
    let released = false;

    try {
      await client.query('BEGIN');
      try {
        for (const step of plan) {
          if (step.kind === 'update') {
            const value = coerceForAffinity(step.column.affinity, step.value);
            const info = await client.query(
              `UPDATE ${described.ref} SET ${quoteIdent(step.column.name)} = $1 WHERE ${step.where.sql}`,
              [toBindable(value), ...step.where.params],
            );
            if (info.rowCount === 0) {
              throw conflict('Row not found — it may have been changed or deleted elsewhere.');
            }
            results.push({ op: 'update', changed: info.rowCount });
            continue;
          }

          if (step.kind === 'delete') {
            const info = await client.query(
              `DELETE FROM ${described.ref} WHERE ${step.where.sql}`,
              step.where.params,
            );
            if (info.rowCount === 0) {
              throw conflict('Row not found — it may have been changed or deleted elsewhere.');
            }
            results.push({ op: 'delete', changed: info.rowCount });
            continue;
          }

          const cols = step.entries.map(([key]) => quoteIdent(key));
          const marks = step.entries.map((_, i) => `$${i + 1}`);
          const values = step.entries.map(([key, value]) =>
            toBindable(coerceForAffinity(byName.get(key).affinity, value)),
          );
          const info = await client.query(
            `INSERT INTO ${described.ref} (${cols.join(', ')}) VALUES (${marks.join(', ')})
             RETURNING ${described.pkColumns.map((c) => quoteIdent(c)).join(', ')}`,
            values,
          );
          const returned = info.rows[0] ?? {};
          results.push({
            op: 'insert',
            rowKey: JSON.stringify(['pk', described.pkColumns.map((c) => toJsonValue(returned[c]))]),
          });
        }
        await client.query('COMMIT');
        this.#counts.clear();
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      if (typeof err.status !== 'number') {
        err.status = pgStatus(err);
        err.code = err.code ?? undefined;
      }
      throw err;
    } finally {
      if (!released) client.release();
    }

    return { applied: results.length, results };
  }

  async close() {
    const pools = [this.#readPool, this.#writePool];
    this.#readPool = null;
    this.#writePool = null;
    this.#typeNames = null;
    await Promise.all(pools.map((pool) => pool?.end().catch(() => {})));
  }
}
