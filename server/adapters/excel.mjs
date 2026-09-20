/**
 * Excel (.xlsx/.xlsm/.xls) and delimited text (.csv/.tsv/.txt) adapter.
 *
 * Each sheet is presented as a table so the UI keeps one mental model. The
 * sheet is held in memory as a grid of raw values, together with the anchor and
 * the formulas of the original used range; mutations edit the grid and rewrite
 * the workbook through a uniquely-named temp file and an atomic rename.
 *
 * A rewrite cannot carry everything. What is lost is listed in `WRITE_CAVEAT`
 * and reported to the UI so the user is told before they switch edit mode on.
 */

import { randomUUID } from 'node:crypto';
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
  '.xlsm': 'xlsm',
  '.xls': 'biff8',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.txt': 'csv',
};

/** Delimited text: read and written with an explicit field separator. */
const DELIMITED = { '.csv': ',', '.tsv': '\t', '.txt': '\t' };

const WRITE_CAVEAT =
  'Saving rewrites the sheet with SheetJS. Values and dates survive; styling, conditional formatting, ' +
  'charts, column widths and images are dropped, and formulas survive only while no row is inserted or deleted.';

export class ExcelAdapter {
  /** Parsed workbook plus its per-sheet grids, dropped when the file changes. */
  #loaded = null;
  #mtime = null;

  constructor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (!(ext in BOOK_TYPE)) {
      const err = new Error(`Unsupported spreadsheet type: ${ext || '(none)'}`);
      err.status = 400;
      throw err;
    }
    this.kind = ext in DELIMITED ? 'csv' : 'excel';
    this.path = filePath;
    this.extension = ext;
    this.bookType = BOOK_TYPE[ext];
    this.fieldSeparator = DELIMITED[ext] ?? null;
  }

  // ------------------------------------------------------------------- loading

  #load() {
    const stat = fs.statSync(this.path);
    const stamp = stat.mtimeMs;
    if (this.#loaded && this.#mtime === stamp) return this.#loaded;

    const readOptions = { cellDates: true, cellFormula: true, bookVBA: true };
    if (this.fieldSeparator) readOptions.FS = this.fieldSeparator;

    const workbook = XLSX.readFile(this.path, readOptions);
    const sheets = new Map();

    for (const name of workbook.SheetNames) {
      const { grid, formulas, origin } = readSheet(workbook.Sheets[name]);
      sheets.set(name, {
        grid,
        formulas,
        origin,
        edited: new Set(),
        structural: false,
        dirty: false,
      });
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

  /**
   * Take the one-and-only backup.
   *
   * It is created exclusively and only when absent, so it keeps holding the
   * pre-edit original however many times the file is written. Instance state
   * cannot track this: a rename changes the inode, which makes SourceManager
   * rebuild the adapter after every write.
   */
  #backupOnce() {
    const backup = `${this.path}.dblens-backup`;
    let existing = null;
    try {
      existing = fs.lstatSync(backup);
    } catch {
      existing = null;
    }

    if (existing) {
      if (existing.isSymbolicLink()) {
        const err = new Error(`Refusing to save: ${backup} is a symbolic link.`);
        err.status = 400;
        throw err;
      }
      return;
    }
    fs.copyFileSync(this.path, backup, fs.constants.COPYFILE_EXCL);
  }

  #writeBack() {
    const loaded = this.#load();
    const workbook = loaded.workbook;

    for (const [name, sheet] of loaded.sheets) {
      if (!sheet.dirty) continue;

      const aoa = sheet.grid.map((row) =>
        row.map((value) => (value === undefined ? null : value)),
      );
      // Rebuild at the sheet's original anchor. aoa_to_sheet alone would move a
      // range that does not start at A1, overwriting whatever lives above it.
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, origin: sheet.origin });

      const width = Math.max(1, sheet.grid.reduce((max, row) => Math.max(max, row.length), 0));
      ws['!ref'] = XLSX.utils.encode_range({
        s: sheet.origin,
        e: {
          r: sheet.origin.r + Math.max(aoa.length - 1, 0),
          c: sheet.origin.c + width - 1,
        },
      });

      // A formula only still means what it meant if the rows did not move.
      if (!sheet.structural) {
        for (const [key, formula] of sheet.formulas) {
          if (sheet.edited.has(key)) continue;
          const [r, c] = key.split(':').map(Number);
          const address = XLSX.utils.encode_cell({
            r: sheet.origin.r + r,
            c: sheet.origin.c + c,
          });
          const cell = ws[address];
          if (cell) cell.f = formula;
          else ws[address] = { t: 'n', f: formula };
        }
      }

      workbook.Sheets[name] = ws;
      sheet.dirty = false;
    }

    this.#backupOnce();

    const writeOptions = {
      type: 'buffer',
      bookType: this.bookType,
      cellDates: true,
      bookVBA: Boolean(workbook.vbaraw),
    };
    if (this.fieldSeparator) writeOptions.FS = this.fieldSeparator;

    const written = XLSX.write(workbook, writeOptions);
    const buffer = this.kind === 'csv' ? stripBom(written) : written;

    // A fresh unique name plus `wx` means the temp path cannot be pre-planted
    // as a symlink, and cannot silently overwrite anything if it somehow is.
    const tmp = `${this.path}.dblens-tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(tmp, buffer, { flag: 'wx' });
      const stat = fs.statSync(this.path);
      fs.renameSync(tmp, this.path);
      fs.chmodSync(this.path, stat.mode);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the temp file was never created */
      }
      throw err;
    }

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
    const size = Math.max(1, Math.min(Math.floor(Number(limit)) || DEFAULT_LIMIT, MAX_LIMIT));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
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
      // Grid rows are relative to the used range, so report the physical sheet
      // row the user would see as the spreadsheet's own row number.
      rowNumbers: page.map((r) => r + sheet.origin.r + 1),
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

  /**
   * Cheap reachability check for the import path: the header bytes catch a file
   * whose extension lies about its contents, without parsing it.
   */
  probe() {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(this.path, 'r');
    let read;
    try {
      read = fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }

    if (read === 0) {
      const err = new Error(`${path.basename(this.path)} is empty.`);
      err.status = 400;
      throw err;
    }

    const signature =
      this.extension === '.xls'
        ? Buffer.from([0xd0, 0xcf, 0x11, 0xe0])
        : this.kind === 'excel'
          ? Buffer.from([0x50, 0x4b, 0x03, 0x04])
          : null;

    if (signature && !head.equals(signature)) {
      const err = new Error(`${path.basename(this.path)} is not a valid ${this.extension} file.`);
      err.status = 400;
      throw err;
    }
    return true;
  }

  /**
   * Validate the whole batch before touching the grid.
   *
   * A batch that fails halfway must leave the sheet exactly as it was: the
   * client is told the write failed, so any rows already changed in memory
   * would silently reach disk on the next successful save. SQLite gets this
   * from a transaction; here it is a plan-then-apply split.
   */
  mutate(name, ops, { hasHeader = true } = {}) {
    const sheet = this.#sheet(name);
    const columns = this.#columns(sheet.grid, hasHeader);
    const firstDataRow = hasHeader ? 1 : 0;

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

    const plan = ops.map((op) => {
      if (op.op === 'update') {
        const target =
          columns.find((c) => c.colIndex === op.columnIndex) ??
          columns.find((c) => c.name === op.column);
        if (!target) throw badRequest(`Unknown column: ${op.column ?? op.columnIndex}`);
        const r = this.#rowIndex(op.rowKey);
        if (r < 0 || r >= sheet.grid.length) {
          throw conflict('Row not found — it may have been changed or deleted elsewhere.');
        }
        return { kind: 'update', r, target, value: op.value };
      }

      if (op.op === 'delete') {
        const r = this.#rowIndex(op.rowKey);
        // With the header toggle off, row 0 is data and must be deletable.
        if (r < firstDataRow || r >= sheet.grid.length) {
          throw conflict('That row cannot be deleted.');
        }
        return { kind: 'delete', r };
      }

      if (op.op === 'insert') {
        const width = Math.max(1, columns.length);
        const row = new Array(width).fill(null);
        for (const [key, value] of Object.entries(op.values ?? {})) {
          const target =
            columns.find((c) => String(c.colIndex) === String(key)) ??
            columns.find((c) => c.name === key);
          if (!target) throw badRequest(`Unknown column: ${key}`);
          row[target.colIndex] = normaliseInput(value);
        }
        const at = op.rowKey ? this.#rowIndex(op.rowKey) : sheet.grid.length;
        return {
          kind: 'insert',
          row,
          at: Math.max(firstDataRow, Math.min(at, sheet.grid.length)),
        };
      }

      throw badRequest(`Unsupported operation: ${op.op}`);
    });

    // Apply, tracking how much earlier structural edits have shifted indices.
    const results = [];
    let delta = 0;
    for (const step of plan) {
      if (step.kind === 'update') {
        sheet.grid[step.r + delta][step.target.colIndex] = normaliseInput(step.value);
        sheet.edited.add(`${step.r + delta}:${step.target.colIndex}`);
        results.push({ op: 'update', changed: 1 });
        continue;
      }
      if (step.kind === 'delete') {
        sheet.grid.splice(step.r + delta, 1);
        delta -= 1;
        sheet.structural = true;
        results.push({ op: 'delete', changed: 1 });
        continue;
      }
      const at = step.at + delta;
      sheet.grid.splice(at, 0, step.row);
      delta += 1;
      sheet.structural = true;
      results.push({ op: 'insert', rowKey: JSON.stringify(['s', at]) });
    }

    if (results.length) {
      sheet.dirty = true;
      this.#writeBack();
    }
    return { applied: results.length, results };
  }

  close() {
    this.#loaded = null;
  }
}

// ------------------------------------------------------------------ utilities

/**
 * Read a worksheet into a grid of rows of raw JS values, remembering where the
 * used range starts and which cells hold formulas.
 */
function readSheet(ws) {
  if (!ws || !ws['!ref']) return { grid: [], formulas: new Map(), origin: { r: 0, c: 0 } };

  const range = XLSX.utils.decode_range(ws['!ref']);
  const grid = [];
  const formulas = new Map();

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cellValue(cell));
      if (cell && typeof cell.f === 'string') {
        formulas.set(`${r - range.s.r}:${c - range.s.c}`, cell.f);
      }
    }
    grid.push(row);
  }

  return { grid, formulas, origin: { r: range.s.r, c: range.s.c } };
}

/** SheetJS writes delimited text with a UTF-8 BOM; the original may not have had one. */
function stripBom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
    ? buffer.subarray(3)
    : buffer;
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
