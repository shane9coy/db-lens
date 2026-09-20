/**
 * Adapter registry.
 *
 * Every adapter exposes the same four calls — `listObjects`, `getSchema`,
 * `getRows`, `mutate` — plus a SQLite-only `query`. The HTTP layer and the UI
 * never branch on source kind; adding Postgres means adding one file here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ExcelAdapter } from './excel.mjs';
import { SqliteAdapter } from './sqlite.mjs';

export const SQLITE_EXTENSIONS = ['.sqlite', '.sqlite3', '.db', '.db3'];
export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv', '.txt'];

export const SUPPORTED_EXTENSIONS = [...SQLITE_EXTENSIONS, ...SPREADSHEET_EXTENSIONS];

/** Decide which adapter owns a path, or throw a 400 with a useful message. */
export function detectKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SQLITE_EXTENSIONS.includes(ext)) return 'sqlite';
  if (SPREADSHEET_EXTENSIONS.includes(ext)) return ext === '.csv' || ext === '.tsv' || ext === '.txt' ? 'csv' : 'excel';
  const err = new Error(
    `Unsupported file type "${ext || '(none)'}". Try one of: ${SUPPORTED_EXTENSIONS.join(', ')}`,
  );
  err.status = 400;
  throw err;
}

/** Instantiate the adapter for a path. Throws if the file is missing. */
export function openAdapter(kind, filePath) {
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

  switch (kind) {
    case 'sqlite':
      return new SqliteAdapter(filePath);
    case 'excel':
    case 'csv':
      return new ExcelAdapter(filePath);
    default: {
      const err = new Error(`No adapter for source kind "${kind}".`);
      err.status = 400;
      throw err;
    }
  }
}

/** True when the adapter for this kind can run free-form SQL. */
export function supportsSql(kind) {
  return kind === 'sqlite';
}

/** True when mutations make sense for this kind. */
export function supportsEdit(kind) {
  return kind === 'sqlite' || kind === 'excel' || kind === 'csv';
}
