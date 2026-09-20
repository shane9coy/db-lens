/**
 * Typed client for the DB Lens API.
 *
 * Row payloads are arrays aligned to `columns` rather than objects: it keeps
 * duplicate spreadsheet headers unambiguous and the 50k-row pages small.
 */

export type SourceKind = 'sqlite' | 'excel' | 'csv';

export interface Source {
  id: number;
  name: string;
  kind: SourceKind;
  path: string;
  editEnabled: boolean;
  canQuery: boolean;
  canEdit: boolean;
  exists: boolean;
  createdAt: string;
  lastOpened: string | null;
}

export interface SourceObject {
  name: string;
  type: string;
  editable: boolean;
  rowCount: number | null;
  columns: number;
}

export interface Column {
  name: string;
  type: string;
  affinity?: string;
  nullable: boolean;
  pk?: boolean;
  binary: boolean;
  /** Spreadsheets only: the sheet column this maps to, for write-back. */
  colIndex?: number;
  /** Spreadsheets only: the original header text, before de-duplication. */
  header?: string | null;
  /** SQLite only: the column default, used to pre-fill an insert. */
  default?: unknown;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: string[];
}

export interface ForeignKey {
  column: string;
  refTable: string;
  refColumn: string | null;
  onDelete: string;
  onUpdate: string;
}

export interface Schema {
  name: string;
  type: string;
  editable: boolean;
  rowIdentity: 'rowid' | 'pk' | 'row' | 'none';
  pkColumns: string[];
  withoutRowid: boolean;
  columnCount: number;
  columns: Column[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  ddl: string | null;
  rowCount: number | null;
  hasHeader?: boolean;
  writeCaveat?: string | null;
  bookType?: string;
}

export interface RowPage {
  columns: Column[];
  rows: unknown[][];
  rowKeys: string[] | null;
  rowKeyKind: string;
  rowNumbers?: number[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
  sql?: string;
}

export type Mutation =
  | { op: 'update'; rowKey: string; column?: string; columnIndex?: number; value: unknown }
  | { op: 'insert'; rowKey?: string; values: Record<string, unknown> }
  | { op: 'delete'; rowKey: string };

export interface MutationResult {
  applied: number;
  results: Array<{ op: string; changed?: number; rowKey?: string | null }>;
}

export interface DirectoryListing {
  dir: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; ext: string; size: number | null }>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(route, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : 'Network error', 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function query(params: Record<string, string | number | boolean | null | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface RowQuery {
  limit?: number;
  offset?: number;
  sort?: string | null;
  dir?: 'asc' | 'desc';
  q?: string | null;
  hasHeader?: boolean;
}

export const api = {
  listSources: () => request<{ sources: Source[] }>('/api/sources'),

  addSource: (path: string) =>
    request<{
      added: Source[];
      failed: Array<{ name: string; error: string }>;
      scanned: number;
      truncated: boolean;
      sources: Source[];
    }>('/api/sources', { method: 'POST', body: JSON.stringify({ path }) }),

  removeSource: (id: number) =>
    request<{ removed: boolean; sources: Source[] }>(`/api/sources/${id}`, { method: 'DELETE' }),

  setEditEnabled: (id: number, editEnabled: boolean) =>
    request<Source>(`/api/sources/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ editEnabled }),
    }),

  listObjects: (id: number) =>
    request<{ source: Source; objects: SourceObject[] }>(`/api/sources/${id}/objects`),

  schema: (id: number, name: string, hasHeader = true) =>
    request<Schema>(
      `/api/sources/${id}/objects/${encodeURIComponent(name)}/schema${query({ header: hasHeader ? 1 : 0 })}`,
    ),

  rows: (id: number, name: string, opts: RowQuery = {}) =>
    request<RowPage>(
      `/api/sources/${id}/objects/${encodeURIComponent(name)}/rows${query({
        limit: opts.limit ?? 200,
        offset: opts.offset ?? 0,
        sort: opts.sort ?? null,
        dir: opts.dir ?? 'asc',
        q: opts.q ?? null,
        header: opts.hasHeader === false ? 0 : 1,
      })}`,
    ),

  mutate: (id: number, name: string, ops: Mutation[], hasHeader = true) =>
    request<MutationResult>(`/api/sources/${id}/objects/${encodeURIComponent(name)}/rows`, {
      method: 'POST',
      body: JSON.stringify({ ops, header: hasHeader }),
    }),

  runQuery: (id: number, sql: string, limit = 500) =>
    request<RowPage>(`/api/sources/${id}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql, limit }),
    }),

  browse: (dir?: string) =>
    request<DirectoryListing>(`/api/fs${dir ? query({ dir }) : ''}`),

  home: () => request<{ home: string }>('/api/fs/home'),
};
