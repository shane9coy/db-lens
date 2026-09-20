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

const INTEGER_LITERAL = /^[+-]?\d+$/;
const DECIMAL_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Coerce a JSON value from the client into something the SQLite driver accepts.
 *
 * Exact integers go through `BigInt`. `Number()` silently rounds past 2^53, so
 * a plain coercion here would corrupt a 64-bit id on the way *in* even though
 * the reader goes to trouble to preserve it on the way out.
 */
export function coerceForAffinity(affinity, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return affinity === 'TEXT' ? String(value) : value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return affinity === 'TEXT' ? String(value) : value;
  }
  if (typeof value !== 'string' || affinity === 'TEXT' || affinity === 'BLOB') return value;

  const trimmed = value.trim();
  if (trimmed === '') return value;

  if (INTEGER_LITERAL.test(trimmed)) {
    if (affinity === 'REAL') return Number(trimmed);
    const exact = BigInt(trimmed);
    return exact >= -MAX_SAFE && exact <= MAX_SAFE ? Number(trimmed) : exact;
  }
  if (DECIMAL_LITERAL.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}

/**
 * A connection string may carry a password. Nothing that leaves the process —
 * an API response, a CLI banner, a log line — should contain it.
 *
 * Built by hand rather than through `URL`, whose serialiser percent-encodes
 * anything non-ASCII in the userinfo and would turn a mask into noise.
 */
export function redactDsn(target) {
  const text = String(target ?? '');
  const schemeEnd = text.indexOf('://');
  if (schemeEnd < 0 || !/^postgres(ql)?$/i.test(text.slice(0, schemeEnd))) return text;

  const userinfoStart = schemeEnd + 3;
  const at = text.lastIndexOf('@');
  if (at < userinfoStart) return text; // no userinfo at all

  const colon = text.indexOf(':', userinfoStart);
  if (colon < 0 || colon > at) return text; // user with no password

  return `${text.slice(0, colon)}:***${text.slice(at)}`;
}
