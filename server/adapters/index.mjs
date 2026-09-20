/**
 * Adapter registry.
 *
 * Every adapter exposes the same calls — `probe`, `listObjects`, `getSchema`,
 * `getRows`, `mutate`, `close` — plus a SQLite-only `query`. The HTTP layer and
 * the UI never branch on source kind; they read the capabilities this file
 * declares (or, for the header-row concept, a flag the adapter itself reports).
 *
 * Construction and capability live in the same table so they cannot drift: a
 * kind that opens but declares no capability would silently hide the SQL
 * console rather than fail.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ExcelAdapter } from './excel.mjs';
import { SqliteAdapter } from './sqlite.mjs';

export const SQLITE_EXTENSIONS = ['.sqlite', '.sqlite3', '.db', '.db3'];
export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt'];
export const SUPPORTED_EXTENSIONS = [...SQLITE_EXTENSIONS, ...SPREADSHEET_EXTENSIONS];

const EXCEL_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];

const ADAPTERS = {
  sqlite: { Adapter: SqliteAdapter, sql: true, edit: true },
  excel: { Adapter: ExcelAdapter, sql: false, edit: true },
  csv: { Adapter: ExcelAdapter, sql: false, edit: true },
};

const REQUIRED_METHODS = ['probe', 'listObjects', 'getSchema', 'getRows', 'mutate', 'close'];

/** Decide which adapter owns a path, or throw a 400 with a useful message. */
export function detectKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SQLITE_EXTENSIONS.includes(ext)) return 'sqlite';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return EXCEL_EXTENSIONS.includes(ext) ? 'excel' : 'csv';

  const err = new Error(
    `Unsupported file type "${ext || '(none)'}". Try one of: ${SUPPORTED_EXTENSIONS.join(', ')}`,
  );
  err.status = 400;
  throw err;
}

/** Instantiate the adapter for a path. Throws if the file is missing. */
export function openAdapter(kind, filePath) {
  const entry = ADAPTERS[kind];
  if (!entry) {
    const err = new Error(`No adapter for source kind "${kind}".`);
    err.status = 400;
    throw err;
  }

  if (!fs.existsSync(filePath)) {
    const err = new Error(`No such file: ${filePath}`);
    err.status = 404;
    throw err;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    const err = new Error(`Not a file: ${filePath}`);
    err.status = 400;
    throw err;
  }

  const adapter = new entry.Adapter(filePath);
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
