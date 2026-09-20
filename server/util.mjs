/** Shared helpers for the source adapters. */

/** Double-quote a SQL identifier, escaping embedded quotes. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Build a parameterised LIKE pattern with `%`/`_`/`\` escaped. Pair with `ESCAPE '\'`. */
export function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const MAX_SAFE = 9007199254740991n;
const BLOB_INLINE_LIMIT = 64 * 1024;

/**
 * Convert a raw driver value into something `JSON.stringify` can carry.
 * Big integers outside the safe range become strings so no precision is lost;
 * large blobs are elided instead of blowing up the payload.
 */
export function toJsonValue(value) {
  if (typeof value === 'bigint') {
    return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) {
    return value.byteLength > BLOB_INLINE_LIMIT
      ? `<blob ${value.byteLength} bytes>`
      : Buffer.from(value).toString('base64');
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function toJsonRow(row) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = toJsonValue(row[key]);
  return out;
}

/**
 * SQLite column affinity, per the rules in the SQLite docs (order matters:
 * INT before CHAR/TEXT, BLOB-or-empty before REAL, everything else NUMERIC).
 */
export function columnAffinity(declaredType) {
  const t = String(declaredType ?? '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

/** True when the declared type should be treated as binary for editing purposes. */
export function isBinaryType(declaredType) {
  return columnAffinity(declaredType) === 'BLOB';
}

/** Coerce a JSON value from the client into something the SQLite driver accepts. */
export function coerceForAffinity(affinity, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return affinity === 'TEXT' ? String(value) : value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return affinity === 'TEXT' ? String(value) : value;
  }
  if (typeof value === 'string') {
    if (affinity === 'INTEGER' || affinity === 'NUMERIC' || affinity === 'REAL') {
      const trimmed = value.trim();
      if (trimmed === '') return value;
      const n = Number(trimmed);
      if (Number.isFinite(n) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return n;
    }
    return value;
  }
  return value;
}

/**
 * Value to bind when addressing a row by key. `toJsonValue` widens oversized
 * integers to strings to protect precision; SQLite still needs to see them as
 * integers to match, and BigInt binds exactly at any magnitude.
 */
export function bindableValue(affinity, value) {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    if (affinity === 'INTEGER' || affinity === 'NUMERIC') {
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    }
  }
  return value;
}

/** Human-readable byte size. */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
