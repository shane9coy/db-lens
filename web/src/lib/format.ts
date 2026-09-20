/** Rendering helpers for raw cell values coming off the wire. */

export type ValueKind = 'null' | 'number' | 'bigint' | 'boolean' | 'date' | 'binary' | 'text';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const BINARY_MARKER = /^<blob (\d+) bytes>$/;

/** The bits of a column that decide how a value should be rendered. */
export interface ColumnShape {
  binary?: boolean;
  type?: string;
  affinity?: string;
}

const WHOLE_NUMBER = /int|numeric|decimal|number|bigint/;

/**
 * Classify a value so the grid can style and align it.
 *
 * The column matters, not just the value: an exact integer too large for a JS
 * number crosses the wire as a digit string, and it should still render as a
 * right-aligned number rather than as text.
 */
export function valueKind(value: unknown, column?: ColumnShape): ValueKind {
  // NULL is NULL whatever the column type — check it before anything else.
  if (value === null || value === undefined) return 'null';
  if (column?.binary) return 'binary';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'bigint') return 'bigint';
  if (typeof value === 'string') {
    if (BINARY_MARKER.test(value)) return 'binary';
    const shape = `${column?.affinity ?? ''} ${column?.type ?? ''}`.toLowerCase();
    if (WHOLE_NUMBER.test(shape) && /^-?\d+$/.test(value) && value.replace('-', '').length > 15) {
      return 'bigint';
    }
    if (ISO_DATE.test(value)) return 'date';
    return 'text';
  }
  return 'text';
}

/**
 * Large integers arrive as digit strings to protect precision. Group them so
 * a 16-digit id is still readable.
 */
export function groupDigits(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += '\u2009';
  }
  return out;
}

export function isDigitString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+$/.test(value) && value.replace('-', '').length > 15;
}

// `toLocaleString('en-US')` builds an ICU formatter on every call (~9µs), and
// this runs once per numeric cell per render — a wide grid re-formats thousands
// of cells per scroll frame. One cached formatter is ~38x faster.
const GROUPED = new Intl.NumberFormat('en-US');

/** The exact text shown in a grid cell (and copied to the clipboard). */
export function formatCell(value: unknown, kind: ValueKind): string {
  if (value === null || value === undefined) return '';
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'number' && typeof value === 'number') {
    return Number.isInteger(value) ? GROUPED.format(value) : String(value);
  }
  if (kind === 'bigint' && typeof value === 'string') return groupDigits(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Shorter form for the row-detail sheet, where space is tighter. */
export function previewCell(value: unknown, kind: ValueKind, max = 120): string {
  const text = formatCell(value, kind);
  if (kind === 'binary') return text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return GROUPED.format(n);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Tailwind classes for a type badge. Kept here so the schema panel, the
 * header and the row detail agree on what "number" looks like.
 */
export const TYPE_TONE: Record<string, string> = {
  number: 'text-type-number border-type-number/35 bg-type-number/10',
  real: 'text-type-number border-type-number/35 bg-type-number/10',
  integer: 'text-type-number border-type-number/35 bg-type-number/10',
  numeric: 'text-type-number border-type-number/35 bg-type-number/10',
  text: 'text-type-text border-type-text/35 bg-type-text/10',
  string: 'text-type-text border-type-text/35 bg-type-text/10',
  date: 'text-type-date border-type-date/35 bg-type-date/10',
  boolean: 'text-type-bool border-type-bool/35 bg-type-bool/10',
  bool: 'text-type-bool border-type-bool/35 bg-type-bool/10',
  binary: 'text-type-blob border-type-blob/35 bg-type-blob/10',
  blob: 'text-type-blob border-type-blob/35 bg-type-blob/10',
  empty: 'text-type-empty border-type-empty/35 bg-type-empty/10',
  mixed: 'text-warning border-warning/35 bg-warning/10',
};

export function typeTone(type: string): string {
  return TYPE_TONE[type.toLowerCase()] ?? 'text-muted-foreground border-border bg-muted/40';
}

/** Short, uniform label for a column type. */
export function shortType(type: string | undefined): string {
  if (!type) return 'any';
  const lowered = type.toLowerCase();
  if (lowered.includes('int')) return 'int';
  if (lowered.includes('char') || lowered.includes('clob') || lowered.includes('text')) return 'text';
  if (lowered.includes('blob') || lowered === '') return 'blob';
  if (lowered.includes('real') || lowered.includes('floa') || lowered.includes('doub')) return 'real';
  return lowered;
}

export const KIND_CLASS: Record<ValueKind, string> = {
  null: 'text-muted-foreground/45 italic',
  number: 'text-type-number tabular text-right',
  bigint: 'text-type-number tabular text-right',
  boolean: 'text-type-bool',
  date: 'text-type-date tabular',
  binary: 'text-type-blob/85 italic',
  text: 'text-foreground',
};
