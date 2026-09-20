import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  Maximize2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Column, Mutation, RowPage, Schema, Source } from '@/lib/api';
import { KIND_CLASS, formatCell, shortType, typeTone, valueKind } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';
import { InsertRowDialog } from '@/components/InsertRowDialog';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    column: Column;
    /** Index into the raw row array. */
    index: number;
  }
}

type Row = unknown[];
type CellPos = { row: number; column: number };
type BufferedEdit = { rowKey: string; column: Column; value: unknown };

const ROW_HEIGHT = 29;
const GUTTER = 46;

/**
 * A workbook save rewrites the whole file — tens of milliseconds on the sample,
 * seconds on a large sheet — so consecutive cell edits there are collected and
 * written together. Every other source updates a single row and saves
 * immediately, which is both cheaper and what a user expects.
 */
const BUFFER_MS = 700;

function columnWidth(column: Column): number {
  const type = (column.type || '').toLowerCase();
  if (/int|real|numeric|number|float|double|decimal/.test(type)) return 124;
  if (/bool/.test(type)) return 92;
  if (/date|time/.test(type)) return 148;
  if (/blob|binary/.test(type)) return 150;
  return Math.min(320, Math.max(152, column.name.length * 8 + 56));
}

function normaliseRect(a: CellPos, b: CellPos) {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.column, b.column),
    right: Math.max(a.column, b.column),
  };
}

/** Turn typed text into a value the adapter can store. */
function parseInput(text: string, column: Column): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const type = (column.type || '').toLowerCase();
  if (/bool/.test(type)) {
    if (/^(true|1|yes|y)$/i.test(trimmed)) return true;
    if (/^(false|0|no|n)$/i.test(trimmed)) return false;
    return trimmed;
  }
  if (/int|real|numeric|number|float|double|decimal/.test(type)) {
    // Integers beyond 2^53 must stay strings: Number() would round them here,
    // before the value even reaches the server, and the server takes strings
    // through BigInt. Only send a number when it is exactly representable.
    if (/^[+-]?\d+$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      return Number.isSafeInteger(asNumber) ? asNumber : trimmed;
    }
    const numeric = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(numeric) && /^[+-]?[\d,]*\.?\d+(?:[eE][+-]?\d+)?$/.test(trimmed)) return numeric;
  }
  return text;
}

export function DataGrid({
  source,
  schema,
  page,
  loading,
  sort,
  filter,
  offset,
  queryKey,
  onSortChange,
  onFilterChange,
  onMutate,
  onOpenRow,
  onRefresh,
}: {
  source: Source;
  schema: Schema;
  page: RowPage;
  loading: boolean;
  sort: { column: string | null; dir: 'asc' | 'desc' };
  filter: string;
  offset: number;
  /** Changes when the query changes — but not when a mutation just refetches. */
  queryKey: string;
  onSortChange: (column: string | null, dir: 'asc' | 'desc') => void;
  onFilterChange: (q: string) => void;
  onMutate: (ops: Mutation[]) => Promise<void>;
  onOpenRow: (index: number) => void;
  onRefresh: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [anchor, setAnchor] = useState<CellPos>({ row: 0, column: 0 });
  const [focus, setFocus] = useState<CellPos>({ row: 0, column: 0 });
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [draft, setDraft] = useState('');
  const [insertOpen, setInsertOpen] = useState(false);
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [bufferedCount, setBufferedCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const editable = source.editEnabled && schema.editable;
  const bufferedWrites = source.kind === 'excel' || source.kind === 'csv';
  /** Edits typed but not yet written, keyed by `${row}:${column}`. */
  const buffer = useRef(new Map<string, BufferedEdit>());
  const flushTimer = useRef<number | null>(null);
  const mutateRef = useRef(onMutate);
  const flushRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    mutateRef.current = onMutate;
  }, [onMutate]);

  const columns = useMemo<ColumnDef<Row, unknown>[]>(
    () =>
      page.columns.map((column, index) => ({
        id: `col-${index}`,
        accessorFn: (row: Row) => row[index],
        header: column.name,
        meta: { column, index },
      })),
    [page.columns],
  );

  const table = useReactTable({
    data: page.rows,
    columns,
    state: { columnVisibility: Object.fromEntries(Object.entries(hidden).map(([k, v]) => [k, !v])) },
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
  });

  const visible = table.getVisibleLeafColumns();
  const widths = useMemo(
    () => visible.map((c) => columnWidth(c.columnDef.meta!.column)),
    [visible],
  );
  const gridTemplate = useMemo(
    () => `${GUTTER}px ${widths.map((w) => `${w}px`).join(' ')}`,
    [widths],
  );
  const totalWidth = useMemo(() => GUTTER + widths.reduce((sum, w) => sum + w, 0), [widths]);
  const leftEdges = useMemo(() => {
    const edges: number[] = [];
    let x = GUTTER;
    for (const w of widths) {
      edges.push(x);
      x += w;
    }
    return edges;
  }, [widths]);

  const rowVirtualizer = useVirtualizer({
    count: page.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
  });

  // A new question resets the viewport and the cursor. A plain refetch (after a
  // mutation) must not — that would yank you away from the cell you just edited.
  useEffect(() => {
    // Anything typed belongs to the view being left, so write it first.
    void flushRef.current();
    setEditing(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setAnchor({ row: 0, column: 0 });
    setFocus({ row: 0, column: 0 });
  }, [queryKey]);

  // After a refetch, keep the cursor where it is unless the page shrank.
  useEffect(() => {
    const maxRow = Math.max(0, page.rows.length - 1);
    const maxColumn = Math.max(0, visible.length - 1);
    setAnchor((p) => ({ row: Math.min(p.row, maxRow), column: Math.min(p.column, maxColumn) }));
    setFocus((p) => ({ row: Math.min(p.row, maxRow), column: Math.min(p.column, maxColumn) }));
  }, [page.rows.length, visible.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(timer);
  }, [notice]);

  const rect = useMemo(() => normaliseRect(anchor, focus), [anchor, focus]);

  const scrollCellIntoView = useCallback(
    (row: number, column: number) => {
      const element = scrollRef.current;
      if (!element) return;

      const top = row * ROW_HEIGHT;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
      }

      const left = leftEdges[column];
      const width = widths[column];
      if (left === undefined || width === undefined) return;

      const right = left + width;
      if (left < element.scrollLeft + GUTTER) element.scrollLeft = left - GUTTER;
      else if (right > element.scrollLeft + element.clientWidth) {
        element.scrollLeft = right - element.clientWidth;
      }
    },
    [leftEdges, widths],
  );

  const moveFocus = useCallback(
    (dRow: number, dColumn: number, extend: boolean) => {
      setFocus((current) => {
        const row = Math.max(0, Math.min(page.rows.length - 1, current.row + dRow));
        const column = Math.max(0, Math.min(visible.length - 1, current.column + dColumn));
        if (!extend) setAnchor({ row, column });
        scrollCellIntoView(row, column);
        return { row, column };
      });
    },
    [page.rows.length, visible.length, scrollCellIntoView],
  );

  /**
   * Write everything typed since the last save, as one batch — one request and,
   * for a workbook, one rewrite.
   */
  const flush = useCallback(async () => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (buffer.current.size === 0) return;

    const entries = [...buffer.current.entries()];
    buffer.current = new Map();
    setBufferedCount(0);
    setInFlight(new Set(entries.map(([key]) => key)));

    try {
      await mutateRef.current(
        entries.map(([, edit]) => ({
          op: 'update' as const,
          rowKey: edit.rowKey,
          column: edit.column.name,
          columnIndex: edit.column.colIndex,
          value: edit.value,
        })),
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setInFlight(new Set());
    }
  }, []);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  /** Save anything outstanding when the tab is hidden or the grid goes away. */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void flushRef.current();
    };
  }, []);

  const commit = useCallback(
    (position: CellPos, text: string) => {
      const meta = visible[position.column]?.columnDef.meta;
      const column = meta?.column;
      const rowKey = page.rowKeys?.[position.row];
      setEditing(null);
      if (!meta || !column || !rowKey) return;

      const key = `${position.row}:${position.column}`;
      const queued = buffer.current.get(key);
      const serverValue = page.rows[position.row]?.[column.colIndex ?? meta.index];
      const next = parseInput(text, column);

      // Compare against what the user last typed, so re-committing an
      // already-buffered cell is still a no-op.
      const reference = queued ? queued.value : serverValue;
      const unchanged =
        next === reference ||
        (next !== null && reference !== null && String(next) === String(reference)) ||
        (next === null && (reference === null || reference === undefined));

      if (unchanged) {
        if (queued) {
          buffer.current.delete(key);
          setBufferedCount(buffer.current.size);
        }
        return;
      }

      if (!bufferedWrites) {
        // A single row update is cheap, so it saves immediately and the
        // interaction is unchanged.
        setInFlight((prev) => new Set(prev).add(key));
        mutateRef
          .current([
            { op: 'update', rowKey, column: column.name, columnIndex: column.colIndex, value: next },
          ])
          .catch((err: unknown) => setNotice(err instanceof Error ? err.message : 'Update failed'))
          .finally(() => {
            setInFlight((prev) => {
              const copy = new Set(prev);
              copy.delete(key);
              return copy;
            });
          });
        return;
      }

      buffer.current.set(key, { rowKey, column, value: next });
      setBufferedCount(buffer.current.size);
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        void flush();
      }, BUFFER_MS);
    },
    [visible, page.rowKeys, page.rows, bufferedWrites, flush],
  );

  const copySelection = useCallback(async () => {
    const lines: string[] = [];
    for (let r = rect.top; r <= rect.bottom; r += 1) {
      const cells: string[] = [];
      for (let c = rect.left; c <= rect.right; c += 1) {
        const meta = visible[c]?.columnDef.meta;
        if (!meta) continue;
        const raw = page.rows[r]?.[meta.column.colIndex ?? meta.index];
        cells.push(raw === null || raw === undefined ? '' : String(raw));
      }
      lines.push(cells.join('\t'));
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice(
        lines.length === 1 && rect.left === rect.right
          ? 'Copied cell'
          : `Copied ${lines.length} × ${rect.right - rect.left + 1}`,
      );
    } catch {
      setNotice('Clipboard blocked by the browser');
    }
  }, [rect, visible, page.rows]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (editing) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void copySelection();
        return;
      }
      if (meta && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setAnchor({ row: 0, column: 0 });
        setFocus({ row: page.rows.length - 1, column: visible.length - 1 });
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveFocus(1, 0, event.shiftKey);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveFocus(-1, 0, event.shiftKey);
          break;
        case 'ArrowRight':
          event.preventDefault();
          moveFocus(0, 1, event.shiftKey);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          moveFocus(0, -1, event.shiftKey);
          break;
        case 'Tab':
          event.preventDefault();
          moveFocus(0, event.shiftKey ? -1 : 1, false);
          break;
        case 'Enter': {
          event.preventDefault();
          const column = visible[focus.column]?.columnDef.meta?.column;
          if (!editable || !column || column.binary || column.readonly) return;
          const raw = page.rows[focus.row]?.[column.colIndex ?? focus.column];
          setDraft(raw === null || raw === undefined ? '' : String(raw));
          setEditing(focus);
          break;
        }
        case 'Escape':
          setAnchor({ row: focus.row, column: focus.column });
          break;
        default:
          break;
      }
    },
    [editing, copySelection, moveFocus, visible, page.rows, focus, editable],
  );

  const deleteRow = useCallback(
    async (index: number) => {
      const rowKey = page.rowKeys?.[index];
      if (!rowKey) return;
      // A structural change shifts every row below it, so buffered edits must
      // be written against the row numbers they were typed on.
      await flushRef.current();
      try {
        await mutateRef.current([{ op: 'delete', rowKey }]);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : 'Delete failed');
      }
    },
    [page.rowKeys],
  );

  const insertRow = useCallback(async (values: Record<string, unknown>) => {
    await flushRef.current();
    await mutateRef.current([{ op: 'insert', values }]);
    setNotice('Row inserted');
  }, []);

  const sortBy = (column: Column) => {
    if (sort.column !== column.name) onSortChange(column.name, 'asc');
    else if (sort.dir === 'asc') onSortChange(column.name, 'desc');
    else onSortChange(null, 'asc');
  };

  const virtualRows = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length
    ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  const hiddenCount = Object.values(hidden).filter(Boolean).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter all columns…"
            className="h-7 w-56 rounded-md border border-input bg-transparent pr-6 pl-7 font-mono text-[11px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring"
          />
          {filter ? (
            <button
              type="button"
              onClick={() => onFilterChange('')}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>

        <span className="font-mono text-[11px] text-muted-foreground">
          {filter || sort.column ? 'filtered' : `${page.rows.length} shown`}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          {notice ? <span className="mr-1 text-[11px] text-warning">{notice}</span> : null}
          {bufferedCount > 0 ? (
            <button
              type="button"
              onClick={() => void flush()}
              title="Save the edits you have typed"
              className="mr-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning hover:bg-warning/20"
            >
              {bufferedCount} unsaved — save
            </button>
          ) : null}

          <Popover
            align="end"
            className="max-h-72 w-60 overflow-auto"
            trigger={({ open, toggle }) => (
              <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={toggle}>
                <Columns3 />
                Columns
                {hiddenCount ? <Badge variant="plain">−{hiddenCount}</Badge> : null}
              </Button>
            )}
          >
            {() => (
              <div className="flex flex-col">
                <div className="flex items-center justify-between px-1 pb-1.5">
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    Visible
                  </span>
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline"
                    onClick={() => setHidden({})}
                  >
                    all
                  </button>
                </div>
                {page.columns.map((column, index) => (
                  <label
                    key={column.colIndex ?? index}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={!hidden[`col-${index}`]}
                      onChange={(event) =>
                        setHidden((prev) => ({ ...prev, [`col-${index}`]: !event.target.checked }))
                      }
                    />
                    <span className="truncate font-mono text-[11px]">{column.name}</span>
                    <Badge className={cn('ml-auto', typeTone(column.type))}>
                      {shortType(column.type)}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
          </Popover>

          {editable ? (
            <Button variant="ghost" size="sm" onClick={() => setInsertOpen(true)}>
              <Plus />
              Row
            </Button>
          ) : null}

          <Button variant="ghost" size="icon-sm" onClick={onRefresh} aria-label="Reload rows">
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={page.total}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <div style={{ minWidth: totalWidth }}>
          <div
            role="row"
            className="sticky top-0 z-20 grid border-b border-border bg-card/95 backdrop-blur"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className="flex h-7 items-center justify-end pr-2 font-mono text-[10px] text-muted-foreground/70">
              #
            </div>
            {visible.map((column) => {
              const meta = column.columnDef.meta!;
              const isSorted = sort.column === meta.column.name;
              return (
                <button
                  key={column.id}
                  type="button"
                  role="columnheader"
                  onClick={() => sortBy(meta.column)}
                  title={`${meta.column.name}${meta.column.type ? ` · ${meta.column.type}` : ''}`}
                  className={cn(
                    'group flex h-7 min-w-0 items-center gap-1.5 border-l border-border/60 px-2 text-left',
                    'hover:bg-accent/60',
                    isSorted && 'bg-accent/40',
                  )}
                >
                  <span
                    className={cn(
                      'truncate font-mono text-[11px]',
                      isSorted ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {meta.column.name}
                  </span>
                  {meta.column.pk ? <span className="text-warning/90 text-[9px]">PK</span> : null}
                  <Badge className={cn('ml-auto shrink-0', typeTone(meta.column.type))}>
                    {shortType(meta.column.type)}
                  </Badge>
                  {isSorted ? (
                    sort.dir === 'asc' ? (
                      <ArrowUp className="size-3 shrink-0 text-primary" />
                    ) : (
                      <ArrowDown className="size-3 shrink-0 text-primary" />
                    )
                  ) : null}
                </button>
              );
            })}
          </div>

          {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : null}

          {virtualRows.map((virtualRow) => {
            const index = virtualRow.index;
            const row = page.rows[index];
            const rowKey = page.rowKeys?.[index];
            const label = page.rowNumbers?.[index] ?? offset + index + 1;

            return (
              <div
                key={virtualRow.key}
                role="row"
                style={{ gridTemplateColumns: gridTemplate, height: ROW_HEIGHT }}
                className="group grid border-b border-border/35 hover:bg-accent/25"
              >
                <div className="flex items-center justify-end gap-1 pr-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground/60 tabular group-hover:hidden">
                    {label}
                  </span>
                  {editable && rowKey ? (
                    <div className="hidden items-center group-hover:flex">
                      <button
                        type="button"
                        title="Delete row"
                        aria-label={`Delete row ${label}`}
                        onClick={() => void deleteRow(index)}
                        className="rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    title="Row detail"
                    aria-label={`Row ${label} detail`}
                    onClick={() => onOpenRow(index)}
                    className="hidden rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground group-hover:block"
                  >
                    <Maximize2 className="size-3" />
                  </button>
                </div>

                {visible.map((column, columnIndex) => {
                  const meta = column.columnDef.meta!;
                  // `columnIndex` indexes the *visible* columns; `meta.index`
                  // indexes the row array. They diverge as soon as a column is
                  // hidden, so the row array must be read by `meta.index`.
                  const sourceIndex = meta.column.colIndex ?? meta.index;
                  const cellKey = `${index}:${columnIndex}`;
                  // A buffered edit is what the user typed, so show it rather
                  // than the value the server still holds.
                  const queued = buffer.current.get(cellKey);
                  const raw = queued ? queued.value : row?.[sourceIndex];
                  const kind = valueKind(raw, meta.column);
                  const isEditing =
                    editing?.row === index && editing?.column === columnIndex;
                  const isPending = inFlight.has(cellKey);
                  const selected =
                    index >= rect.top &&
                    index <= rect.bottom &&
                    columnIndex >= rect.left &&
                    columnIndex <= rect.right;

                  return (
                    <div
                      key={column.id}
                      role="gridcell"
                      aria-colindex={columnIndex + 1}
                      tabIndex={-1}
                      onMouseDown={(event) => {
                        const next = { row: index, column: columnIndex };
                        setFocus(next);
                        // Plain click moves the anchor; shift-click extends the
                        // selection from wherever it already is.
                        if (!event.shiftKey) {
                          setAnchor(next);
                          setEditing(null);
                        }
                      }}
                      onDoubleClick={() => {
                        if (!editable || meta.column.binary || meta.column.readonly || !rowKey) return;
                        setDraft(raw === null || raw === undefined ? '' : String(raw));
                        setEditing({ row: index, column: columnIndex });
                      }}
                      title={raw === null || raw === undefined ? 'NULL' : String(raw)}
                      className={cn(
                        'flex min-w-0 items-center overflow-hidden border-l border-border/40 px-2 font-mono text-[11px] leading-none',
                        KIND_CLASS[kind],
                        selected && 'bg-primary/10',
                        focus.row === index &&
                          focus.column === columnIndex &&
                          'ring-1 ring-inset ring-primary/70',
                        isPending && 'opacity-45',
                        queued && 'bg-warning/12',
                        editable && !meta.column.binary && !meta.column.readonly && 'cursor-cell',
                      )}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => commit({ row: index, column: columnIndex }, draft)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              commit({ row: index, column: columnIndex }, draft);
                              moveFocus(1, 0, false);
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditing(null);
                            } else if (event.key === 'Tab') {
                              event.preventDefault();
                              commit({ row: index, column: columnIndex }, draft);
                              moveFocus(0, event.shiftKey ? -1 : 1, false);
                            }
                          }}
                          className="h-full w-full bg-transparent font-mono text-[11px] text-foreground outline-none"
                        />
                      ) : (
                        <span className={cn('truncate', kind === 'null' && 'opacity-60')}>
                          {kind === 'null' ? 'NULL' : formatCell(raw, kind)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}

          {page.rows.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
              {filter ? `No rows match “${filter}”` : 'This table is empty'}
            </div>
          ) : null}
        </div>
      </div>

      <InsertRowDialog
        open={insertOpen}
        onOpenChange={setInsertOpen}
        objectName={schema.name}
        columns={schema.columns}
        source={source}
        onInsert={insertRow}
      />
    </div>
  );
}
