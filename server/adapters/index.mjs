/**
 * Adapter registry.
 *
 * Every adapter exposes the same calls — `probe`, `listObjects`, `getSchema`,
 * `getRows`, `mutate`, `close` — plus a `query` where SQL makes sense. The HTTP
 * layer and the UI never branch on source kind; they read the capabilities this
 * file declares (or, for the header-row concept, a flag the adapter reports).
 *
 * Construction and capability live in the same table so they cannot drift: a
 * kind that opens but declares no capability would silently hide the SQL
 * console rather than fail. `file` records whether the target is a filesystem
 * path, which is what lets a connection string skip the existence and
 * staleness checks that only make sense for a file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ExcelAdapter } from './excel.mjs';
import { PostgresAdapter } from './postgres.mjs';
import { SqliteAdapter } from './sqlite.mjs';

export const SQLITE_EXTENSIONS = ['.sqlite', '.sqlite3', '.db', '.db3'];
export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt'];
export const SUPPORTED_EXTENSIONS = [...SQLITE_EXTENSIONS, ...SPREADSHEET_EXTENSIONS];

const EXCEL_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];
const POSTGRES_URL = /^postgres(ql)?:\/\//i;

const ADAPTERS = {
  sqlite: { Adapter: SqliteAdapter, sql: true, edit: true, file: true },
  excel: { Adapter: ExcelAdapter, sql: false, edit: true, file: true },
  csv: { Adapter: ExcelAdapter, sql: false, edit: true, file: true },
  postgres: { Adapter: PostgresAdapter, sql: true, edit: true, file: false },
};

const REQUIRED_METHODS = ['probe', 'listObjects', 'getSchema', 'getRows', 'mutate', 'close'];

/** True when a source kind is addressed by a path on disk. */
export function isFileKind(kind) {
  return ADAPTERS[kind]?.file === true;
}

/** A connection string is recognised by scheme, everything else by extension. */
export function isConnectionString(target) {
  return POSTGRES_URL.test(String(target ?? ''));
}

/** Decide which adapter owns a target, or throw a 400 with a useful message. */
export function detectKind(target) {
  if (isConnectionString(target)) return 'postgres';

  const ext = path.extname(String(target)).toLowerCase();
  if (SQLITE_EXTENSIONS.includes(ext)) return 'sqlite';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return EXCEL_EXTENSIONS.includes(ext) ? 'excel' : 'csv';

  const err = new Error(
    `Unsupported target "${ext || '(no extension)'}". Use one of: ` +
      `${SUPPORTED_EXTENSIONS.join(', ')}, or a postgres:// connection string.`,
  );
  err.status = 400;
  throw err;
}

/** Instantiate the adapter for a target. Throws if a file target is missing. */
export function openAdapter(kind, target) {
  const entry = ADAPTERS[kind];
  if (!entry) {
    const err = new Error(`No adapter for source kind "${kind}".`);
    err.status = 400;
    throw err;
  }

  if (entry.file) {
    if (!fs.existsSync(target)) {
      const err = new Error(`No such file: ${target}`);
      err.status = 404;
      throw err;
    }
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      const err = new Error(`Not a file: ${target}`);
      err.status = 400;
      throw err;
    }
  }

  const adapter = new entry.Adapter(target);
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      const err = new Error(`Adapter for "${kind}" does not implement ${method}().`);
      err.status = 500;
      throw err;
    }
  }
  return adapter;
}

/** True when the adapter for this kind can run free-form SQL. */
export function supportsSql(kind) {
  return ADAPTERS[kind]?.sql === true;
}

/** True when mutations make sense for this kind. */
export function supportsEdit(kind) {
  return ADAPTERS[kind]?.edit === true;
}
