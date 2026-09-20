/**
 * Excel (.xlsx/.xlsm/.xls) and CSV adapter.
 *
 * Each sheet is presented as a table so the UI keeps one mental model. The
 * sheet is held in memory as a grid of raw values; mutations edit the grid and
 * rewrite the whole workbook via an atomic temp-file rename. Cell styles,
 * formulas and column widths are NOT preserved on write — the schema response
 * reports `writeCaveat` so the UI can warn before enabling edit mode.
 */

import fs from 'node:fs';
import path from 'node:path';
import XLSXModule from 'xlsx';

// xlsx ships no `exports` map, so Node loads the CJS build and synthesises a
// *partial* named-export namespace (`readFile` is absent, `utils` is present).
// The default export is the complete object; prefer it when it is there.
const XLSX = XLSXModule?.default ?? XLSXModule;

const MAX_LIMIT = 2000;
const DEFAULT_LIMIT = 200;
const TYPE_SAMPLE = 250;

const BOOK_TYPE = {
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.xls': 'biff8',
  '.csv': 'csv',
  '.txt': 'csv',
};

const WRITE_CAVEAT =
  'Saving rewrites the sheet with SheetJS: cell values, dates and formulas-as-text survive, ' +
  'but styling, conditional formatting, charts, column widths and images are dropped.';

export class ExcelAdapter {
  /** Parsed workbook plus its per-sheet grids, dropped when the file changes. */
  #loaded = null;
  #mtime = null;
  #backedUp = false;

  constructor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!(ext in BOOK_TYPE)) {
      const err = new Error(`Unsupported spreadsheet type: ${ext || '(none)'}`);
      err.status = 400;
      throw err;
    }
    this.kind = ext === '.csv' || ext === '.txt' ? 'csv' : 'excel';
    this.path = filePath;
    this.extension = ext;
    this.bookType = BOOK_TYPE[ext];
  }

  // ------------------------------------------------------------------- loading

  #load() {
    const stat = fs.statSync(this.path);
    const stamp = stat.mtimeMs;
    if (this.#loaded && this.#mtime === stamp) return this.#loaded;

    const workbook = XLSX.readFile(this.path, { cellDates: true, cellFormula: true });
    const sheets = new Map();

    for (const name of workbook.SheetNames) {
      sheets.set(name, { grid: sheetToGrid(workbook.Sheets[name]), dirty: false });
    }

    this.#loaded = { workbook, sheets };
    this.#mtime = stamp;
    return this.#loaded;
  }

  /** The workbook changed underneath us — drop the cache so the next read reloads. */
  #invalidateIfStale() {
    try {
      const stamp = fs.statSync(this.path).mtimeMs;
      if (this.#mtime !== null && stamp !== this.#mtime) {
        this.#loaded = null;
        this.#mtime = null;
      }
    } catch {
      /* file vanished; the next load will raise a clear error */
    }
  }

  #sheet(name) {
    this.#invalidateIfStale();
    const loaded = this.#load();
    const sheet = loaded.sheets.get(name);
    if (!sheet) {
      const err = new Error(`No such sheet: ${name}`);
      err.status = 404;
      throw err;
    }
    return sheet;
  }

  // ---------------------------------------------------------------- grid model

  /** Build column descriptors from the header row (or from the widest row). */
  #columns(grid, hasHeader) {
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const header = hasHeader ? (grid[0] ?? []) : [];
    const seen = new Map();

    const columns = [];
    for (let c = 0; c < width; c += 1) {
      let label;
      if (hasHeader) {
        const raw = header[c];
        label = raw === null || raw === undefined || raw === '' ? '' : String(raw).trim();
      } else {
        label = '';
      }
      if (label === '') label = `column_${c + 1}`;

      // Sheets routinely repeat a header; keep names unique but stable.
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      const name = count === 1 ? label : `${label} (${count})`;

      const sample = [];
      for (let r = hasHeader ? 1 : 0; r < grid.length && sample.length < TYPE_SAMPLE; r += 1) {
        sample.push(grid[r][c] ?? null);
      }

      columns.push({
        name,
        colIndex: c,
        type: inferType(sample),
        header: hasHeader ? (header[c] ?? null) : null,
        // A sheet has no constraints — any cell may be blank, so claiming
        // NOT NULL from a sample would be a false statement about the data.
        nullable: true,
        pk: false,
        binary: false,
      });
    }
    return columns;
  }

  /** Apply the optional substring filter, returning original data-row indices. */
  #selectIndices(sheet, hasHeader, columns, q) {
    const start = hasHeader ? 1 : 0;
    const indices = [];
    const needle = q === null || q === undefined || String(q) === '' ? null : String(q).toLowerCase();

    for (let r = start; r < sheet.grid.length; r += 1) {
      if (needle === null) {
        indices.push(r);
        continue;
      }
      const row = sheet.grid[r];
      for (let c = 0; c < columns.length; c += 1) {
        const value = row[columns[c].colIndex];
        if (value === null || value === undefined) continue;
        if (formatValue(value).toLowerCase().includes(needle)) {
          indices.push(r);
          break;
        }
      }
    }
    return indices;
  }

  #sortIndices(sheet, columns, indices, sort, dir) {
    if (!sort) return indices;
    const column = columns.find((c) => c.name === sort) ?? columns.find((c) => String(c.colIndex) === String(sort));
    if (!column) return indices;
    const factor = String(dir).toLowerCase() === 'desc' ? -1 : 1;
    const c = column.colIndex;

    return [...indices].sort((a, b) => factor * compareValues(sheet.grid[a][c] ?? null, sheet.grid[b][c] ?? null));
  }

  /** Decode an opaque row key into the grid row it addresses. */
  #rowIndex(rowKey) {
    let key;
    try {
      key = JSON.parse(rowKey);
    } catch {
      key = null;
    }
    if (!Array.isArray(key) || key[0] !== 's' || !Number.isInteger(key[1])) {
      const err = new Error('Malformed row key.');
      err.status = 400;
      throw err;
    }
    return key[1];
  }

  #writeBack() {
    const loaded = this.#load();
    const workbook = loaded.workbook;

    for (const [name, sheet] of loaded.sheets) {
      if (!sheet.dirty) continue;
      const aoa = sheet.grid.map((row) =>
        row.map((value) => (value === undefined ? null : value)),
      );
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
      // aoa_to_sheet derives the range from the data; pin it to the grid so a
      // trailing all-empty row is not silently trimmed away.
      ws['!ref'] = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(aoa.length - 1, 0), c: Math.max((aoa[0]?.length ?? 1) - 1, 0) },
      });
      workbook.Sheets[name] = ws;
      sheet.dirty = false;
    }

    // One backup per file per process, taken before the first mutation.
    if (!this.#backedUp) {
      try {
        fs.copyFileSync(this.path, `${this.path}.dblens-backup`);
      } catch {
        /* best effort only */
      }
      this.#backedUp = true;
    }

    const tmp = `${this.path}.dblens-tmp`;
    XLSX.writeFile(workbook, tmp, { bookType: this.bookType, cellDates: true });

    const stat = fs.statSync(this.path);
    fs.renameSync(tmp, this.path);
    fs.chmodSync(this.path, stat.mode);
    this.#mtime = fs.statSync(this.path).mtimeMs;
  }

  // ---------------------------------------------------------------- public API

  listObjects() {
    this.#invalidateIfStale();
    const loaded = this.#load();
    return loaded.workbook.SheetNames.map((name) => {
      const grid = loaded.sheets.get(name).grid;
      return {
        name,
        type: 'sheet',
        editable: true,
        rowCount: Math.max(grid.length - 1, 0),
        columns: grid.reduce((max, row) => Math.max(max, row.length), 0),
      };
    });
  }

  getSchema(name, { hasHeader = true } = {}) {
    const sheet = this.#sheet(name);
    const columns = this.#columns(sheet.grid, hasHeader);
    return {
      name,
      type: 'sheet',
      editable: true,
      rowIdentity: 'row',
      pkColumns: [],
      withoutRowid: false,
      columnCount: columns.length,
      columns,
      indexes: [],
      foreignKeys: [],
      ddl: null,
      hasHeader,
      rowCount: Math.max(sheet.grid.length - (hasHeader ? 1 : 0), 0),
      writeCaveat: this.kind === 'csv' ? null : WRITE_CAVEAT,
      bookType: this.bookType,
    };
  }

  getRows(name, { limit = DEFAULT_LIMIT, offset = 0, sort = null, dir = 'asc', q = null, hasHeader = true } = {}) {
    const sheet = this.#sheet(name);
    const size = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
    const skip = Math.max(0, Number(offset) || 0);
    const columns = this.#columns(sheet.grid, hasHeader);

    const filtered = this.#selectIndices(sheet, hasHeader, columns, q);
    const ordered = this.#sortIndices(sheet, columns, filtered, sort, dir);
    const page = ordered.slice(skip, skip + size);

    const rows = page.map((r) =>
      columns.map((c) => {
        const value = sheet.grid[r][c.colIndex];
        return value === undefined ? null : value;
      }),
    );

    return {
      columns,
      rows,
      rowKeys: page.map((r) => JSON.stringify(['s', r])),
      rowKeyKind: 'row',
      rowNumbers: page.map((r) => r + 1),
      total: ordered.length,
      limit: size,
      offset: skip,
      truncated: skip + rows.length < ordered.length,
    };
  }

  query() {
    const err = new Error('SQL is not available for spreadsheets — use the filter box instead.');
    err.status = 400;
    throw err;
  }

  mutate(name, ops, { hasHeader = true } = {}) {
    const sheet = this.#sheet(name);
    const columns = this.#columns(sheet.grid, hasHeader);
    const results = [];

    for (const op of ops) {
      if (op.op === 'update') {
        const target =
          columns.find((c) => c.colIndex === op.columnIndex) ??
          columns.find((c) => c.name === op.column);
        if (!target) {
          const err = new Error(`Unknown column: ${op.column ?? op.columnIndex}`);
          err.status = 400;
          throw err;
        }
        const r = this.#rowIndex(op.rowKey);
        if (r < 0 || r >= sheet.grid.length) {
          const err = new Error('Row not found — it may have been changed or deleted elsewhere.');
          err.status = 409;
          throw err;
        }
        sheet.grid[r][target.colIndex] = normaliseInput(op.value);
        sheet.dirty = true;
        results.push({ op: 'update', changed: 1 });
        continue;
      }

      if (op.op === 'delete') {
        const r = this.#rowIndex(op.rowKey);
        if (r <= 0 || r >= sheet.grid.length) {
          const err = new Error('That row cannot be deleted.');
          err.status = 409;
          throw err;
        }
        sheet.grid.splice(r, 1);
        sheet.dirty = true;
        results.push({ op: 'delete', changed: 1 });
        continue;
      }

      if (op.op === 'insert') {
        const width = columns.length || 1;
        const row = new Array(width).fill(null);
        for (const [key, value] of Object.entries(op.values ?? {})) {
          const target =
            columns.find((c) => String(c.colIndex) === String(key)) ?? columns.find((c) => c.name === key);
          if (!target) {
            const err = new Error(`Unknown column: ${key}`);
            err.status = 400;
            throw err;
          }
          row[target.colIndex] = normaliseInput(value);
        }
        const at = op.rowKey ? this.#rowIndex(op.rowKey) : sheet.grid.length;
        const insertAt = Math.max(hasHeader ? 1 : 0, Math.min(at, sheet.grid.length));
        sheet.grid.splice(insertAt, 0, row);
        sheet.dirty = true;
        results.push({ op: 'insert', rowKey: JSON.stringify(['s', insertAt]) });
        continue;
      }

      const err = new Error(`Unsupported operation: ${op.op}`);
      err.status = 400;
      throw err;
    }

    if (sheet.dirty) this.#writeBack();
    return { applied: results.length, results };
  }

  close() {
    this.#loaded = null;
  }
}

// ------------------------------------------------------------------ utilities

/** Read a worksheet into an array of rows of raw JS values. */
function sheetToGrid(ws) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const grid = [];

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cellValue(cell));
    }
    grid.push(row);
  }
  return grid;
}

function cellValue(cell) {
  if (!cell) return null;
  if (cell.t === 'e') return cell.w ?? '#ERROR!';
  if (cell.t === 'z' || cell.v === undefined) return null;
  if (cell.t === 'd') return cell.v instanceof Date ? cell.v : new Date(cell.v);
  if (cell.t === 'n') return typeof cell.v === 'number' ? cell.v : Number(cell.v);
  if (cell.t === 'b') return Boolean(cell.v);
  if (cell.t === 's') return String(cell.v);
  return cell.v ?? null;
}

function inferType(sample) {
  const seen = new Set();
  let meaningful = 0;

  for (const value of sample) {
    if (value === null || value === undefined || value === '') continue;
    meaningful += 1;
    if (value instanceof Date) seen.add('date');
    else if (typeof value === 'number') seen.add('number');
    else if (typeof value === 'boolean') seen.add('boolean');
    else seen.add('string');
  }

  if (meaningful === 0) return 'empty';
  if (seen.size === 1) return [...seen][0];
  return 'mixed';
}

function typeRank(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return 1;
  if (value instanceof Date) return 2;
  if (typeof value === 'boolean') return 3;
  return 4;
}

function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;

  if (ra === 1 || ra === 2) {
    const va = ra === 2 ? a.getTime() : a;
    const vb = ra === 2 ? b.getTime() : b;
    return va === vb ? 0 : va < vb ? -1 : 1;
  }
  if (ra === 3) return a === b ? 0 : a ? 1 : -1;

  const sa = String(a);
  const sb = String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Render a raw cell value for filtering and display. */
function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
    return time === '00:00:00' ? iso : `${iso} ${time}`;
  }
  return String(value);
}

/** Turn a value coming off the wire into something the grid can hold. */
function normaliseInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value === '') return null;
  return value;
}
