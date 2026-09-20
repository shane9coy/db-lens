import {
  AlertTriangle,
  Database,
  FileSpreadsheet,
  FileText,
  Loader2,
  PanelRight,
  Table2,
  Terminal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Mutation,
  type RowPage,
  type Schema,
  type Source,
  type SourceObject,
  api,
} from '@/lib/api';
import { DataGrid } from '@/components/DataGrid';
import { PathBar } from '@/components/PathBar';
import { QuickSwitch } from '@/components/QuickSwitch';
import { RowDetail } from '@/components/RowDetail';
import { SchemaPanel } from '@/components/SchemaPanel';
import { SourceRail } from '@/components/SourceRail';
import { SqlConsole } from '@/components/SqlConsole';
import { StatusBar } from '@/components/StatusBar';
import { Button } from '@/components/ui/button';

const PAGE_SIZE = 500;

function readHash(): { sourceId: number | null; objectName: string | null } {
  const match = window.location.hash.match(/^#\/source\/(\d+)(?:\/(.+))?$/);
  if (!match) return { sourceId: null, objectName: null };
  return { sourceId: Number(match[1]), objectName: match[2] ? decodeURIComponent(match[2]) : null };
}

/** replaceState keeps the address bar in sync without firing `hashchange`. */
function writeHash(sourceId: number, objectName?: string | null) {
  const next = `#/source/${sourceId}${objectName ? `/${encodeURIComponent(objectName)}` : ''}`;
  if (window.location.hash !== next) window.history.replaceState(null, '', next);
}

export default function App() {
  const [sources, setSources] = useState<Source[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<number | null>(null);
  const [objects, setObjects] = useState<SourceObject[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [activeObject, setActiveObject] = useState<string | null>(null);

  const [schema, setSchema] = useState<Schema | null>(null);
  const [page, setPage] = useState<RowPage | null>(null);
  const [sort, setSort] = useState<{ column: string | null; dir: 'asc' | 'desc' }>({
    column: null,
    dir: 'asc',
  });
  const [filter, setFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [offset, setOffset] = useState(0);

  const [rowsLoading, setRowsLoading] = useState(false);
  const [latency, setLatency] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pathMessage, setPathMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pathBusy, setPathBusy] = useState(false);

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [schemaOpen, setSchemaOpen] = useState(true);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<number | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [objectsToken, setObjectsToken] = useState(0);

  const activeSource = useMemo(
    () => sources.find((source) => source.id === activeSourceId) ?? null,
    [sources, activeSourceId],
  );

  const refreshSources = useCallback(async () => {
    try {
      const { sources: list } = await api.listSources();
      setSources(list);
      return list;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the DB Lens server');
      return [];
    }
  }, []);

  // Restore the view named in the URL — the CLI opens `#/source/<id>` after
  // registering a path.
  useEffect(() => {
    void (async () => {
      const { sourceId } = readHash();
      const list = await refreshSources();
      if (sourceId !== null && list.some((source) => source.id === sourceId)) {
        setActiveSourceId(sourceId);
      } else if (list.length) {
        setActiveSourceId(list[0].id);
      }
    })();
  }, [refreshSources]);

  // `writeHash` uses replaceState, so this only fires for navigations the app
  // did not make: the back button, or a link opened into a running tab.
  useEffect(() => {
    const onHashChange = () => {
      const { sourceId, objectName } = readHash();
      if (sourceId === null) return;
      setActiveSourceId(sourceId);
      setActiveObject(objectName);
      setSort({ column: null, dir: 'asc' });
      setFilter('');
      setAppliedFilter('');
      setOffset(0);
      setDetailRow(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (activeSourceId === null) {
      setObjects([]);
      setActiveObject(null);
      return;
    }

    let cancelled = false;
    setObjectsLoading(true);
    api
      .listObjects(activeSourceId)
      .then(({ objects: list }) => {
        if (cancelled) return;
        setObjects(list);
        const fromHash = readHash().objectName;
        setActiveObject((current) => {
          if (current && list.some((object) => object.name === current)) return current;
          if (fromHash && list.some((object) => object.name === fromHash)) return fromHash;
          return list[0]?.name ?? null;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not list objects');
      })
      .finally(() => {
        if (!cancelled) setObjectsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSourceId, objectsToken]);

  useEffect(() => {
    if (activeSourceId === null || !activeObject) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    api
      .schema(activeSourceId, activeObject)
      .then((next) => {
        if (!cancelled) setSchema(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the schema');
      });
    return () => {
      cancelled = true;
    };
  }, [activeSourceId, activeObject, refreshToken]);

  useEffect(() => {
    if (activeSourceId === null || !activeObject) {
      setPage(null);
      return;
    }
    let cancelled = false;
    setRowsLoading(true);
    const started = performance.now();

    api
      .rows(activeSourceId, activeObject, {
        limit: PAGE_SIZE,
        offset,
        sort: sort.column,
        dir: sort.dir,
        q: appliedFilter,
      })
      .then((next) => {
        if (cancelled) return;
        setPage(next);
        setLatency(Math.round(performance.now() - started));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load rows');
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSourceId, activeObject, sort.column, sort.dir, appliedFilter, offset, refreshToken]);

  // Typing in the filter box should not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedFilter(filter);
      setOffset(0);
    }, 220);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSwitcherOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectObject = useCallback(
    (name: string) => {
      setActiveObject(name);
      setSort({ column: null, dir: 'asc' });
      setFilter('');
      setAppliedFilter('');
      setOffset(0);
      setDetailRow(null);
      if (activeSourceId !== null) writeHash(activeSourceId, name);
    },
    [activeSourceId],
  );

  const selectSource = useCallback(
    (source: Source) => {
      setActiveSourceId(source.id);
      setActiveObject(null);
      setPage(null);
      setSchema(null);
      setSort({ column: null, dir: 'asc' });
      setFilter('');
      setAppliedFilter('');
      setOffset(0);
      setDetailRow(null);
      setExpanded((prev) => ({ ...prev, [source.id]: true }));
      writeHash(source.id, null);
    },
    [],
  );

  const openPath = useCallback(
    async (target: string) => {
      setPathBusy(true);
      setPathMessage(null);
      try {
        const result = await api.addSource(target);
        await refreshSources();
        for (const failure of result.failed) {
          setPathMessage({ kind: 'error', text: `${failure.name}: ${failure.error}` });
        }
        if (result.added.length) {
          const first = result.added[0];
          setPathMessage({
            kind: 'ok',
            text:
              result.added.length === 1
                ? `opened ${first.name}`
                : `opened ${result.added.length} files from ${first.path.replace(/\/[^/]+$/, '')}`,
          });
          setActiveSourceId(first.id);
          setActiveObject(null);
          setExpanded((prev) => ({ ...prev, [first.id]: true }));
          setObjectsToken((token) => token + 1);
          writeHash(first.id, null);
        } else if (!result.failed.length) {
          setPathMessage({ kind: 'error', text: 'nothing openable found at that path' });
        }
      } catch (err) {
        setPathMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not open' });
      } finally {
        setPathBusy(false);
      }
    },
    [refreshSources],
  );

  const mutate = useCallback(
    async (ops: Mutation[]) => {
      if (activeSourceId === null || !activeObject) return;
      await api.mutate(activeSourceId, activeObject, ops);
      setRefreshToken((token) => token + 1);
      setObjectsToken((token) => token + 1);
    },
    [activeSourceId, activeObject],
  );

  const toggleEdit = useCallback(
    async (enabled: boolean) => {
      if (activeSourceId === null) return;
      try {
        await api.setEditEnabled(activeSourceId, enabled);
        await refreshSources();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not change edit mode');
      }
    },
    [activeSourceId, refreshSources],
  );

  const removeSource = useCallback(
    async (source: Source) => {
      try {
        const { sources: list } = await api.removeSource(source.id);
        setSources(list);
        if (activeSourceId === source.id) {
          setActiveSourceId(list[0]?.id ?? null);
          setActiveObject(null);
          setPage(null);
          setSchema(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not remove the source');
      }
    },
    [activeSourceId],
  );

  const detailLabel = useMemo(() => {
    if (!page || detailRow === null) return '';
    return String(page.rowNumbers?.[detailRow] ?? offset + detailRow + 1);
  }, [page, detailRow, offset]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-2">
        <span className="flex items-center gap-1.5 pl-1">
          <Database className="size-3.5 text-primary" />
          <span className="text-xs font-semibold tracking-tight">DB Lens</span>
        </span>

        {activeSource ? (
          <span className="flex min-w-0 items-center gap-1.5 border-l border-border pl-2">
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {activeSource.name}
            </span>
            {activeObject ? (
              <>
                <span className="text-muted-foreground/40">/</span>
                <span className="flex items-center gap-1 truncate font-mono text-[11px]">
                  <Table2 className="size-3 shrink-0 text-muted-foreground" />
                  {activeObject}
                </span>
              </>
            ) : null}
          </span>
        ) : null}

        {rowsLoading ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setSwitcherOpen(true)}>
            Jump to table
            <span className="ml-0.5 font-mono text-[9px] text-muted-foreground">⌘K</span>
          </Button>

          {activeSource?.canQuery ? (
            <Button
              variant={consoleOpen ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setConsoleOpen((v) => !v)}
            >
              <Terminal />
              SQL
            </Button>
          ) : null}

          <Button
            variant={schemaOpen ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setSchemaOpen((v) => !v)}
            disabled={!schema}
            aria-label="Toggle schema panel"
            title="Toggle schema panel"
          >
            <PanelRight />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFocusToken((token) => token + 1)}
            title="Focus the path bar"
          >
            Open path
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <SourceRail
          sources={sources}
          objects={objects}
          activeSourceId={activeSourceId}
          activeObject={activeObject}
          objectsLoading={objectsLoading}
          expanded={expanded}
          onToggleExpanded={(id) => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? id === activeSourceId) }))}
          onSelectSource={selectSource}
          onSelectObject={selectObject}
          onRemoveSource={(source) => void removeSource(source)}
          onRequestOpen={() => setFocusToken((token) => token + 1)}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <PathBar onOpenPath={openPath} busy={pathBusy} message={pathMessage} focusToken={focusToken} />

          {error ? (
            <div className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
              <AlertTriangle className="size-3 shrink-0" />
              <span className="truncate">{error}</span>
              <button
                type="button"
                className="ml-auto shrink-0 underline"
                onClick={() => setError(null)}
              >
                dismiss
              </button>
            </div>
          ) : null}

          {activeSource && page && schema ? (
            <>
              <DataGrid
                source={activeSource}
                schema={schema}
                page={page}
                loading={rowsLoading}
                sort={sort}
                filter={filter}
                offset={offset}
                onSortChange={(column, dir) => setSort({ column, dir })}
                onFilterChange={setFilter}
                onMutate={mutate}
                onOpenRow={setDetailRow}
                onRefresh={() => setRefreshToken((token) => token + 1)}
              />

              {page.total > PAGE_SIZE ? (
                <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + PAGE_SIZE >= page.total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {Math.floor(offset / PAGE_SIZE) + 1} of {Math.ceil(page.total / PAGE_SIZE)} pages
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                    {page.total > 0
                      ? `${PAGE_SIZE} rows per page · paging is server-side`
                      : ''}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState onOpenPath={openPath} onBrowse={() => setFocusToken((token) => token + 1)} />
          )}

          {consoleOpen && activeSource?.canQuery ? (
            <SqlConsole source={activeSource} onClose={() => setConsoleOpen(false)} />
          ) : null}
        </main>

        {schemaOpen && schema && activeSource ? (
          <SchemaPanel
            source={activeSource}
            schema={schema}
            onClose={() => setSchemaOpen(false)}
            onToggleEdit={(enabled) => void toggleEdit(enabled)}
          />
        ) : null}
      </div>

      <StatusBar
        source={activeSource}
        objectName={activeObject}
        total={page?.total ?? 0}
        shown={page?.rows.length ?? 0}
        offset={offset}
        latencyMs={latency}
        selection={page?.rowKeys ? 'copyable' : null}
      />

      <QuickSwitch
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        sources={sources}
        onPick={(source, object) => {
          selectSource(source);
          selectObject(object.name);
        }}
      />

      {page && schema && activeSource && detailRow !== null ? (
        <RowDetail
          open
          onOpenChange={(open) => {
            if (!open) setDetailRow(null);
          }}
          rowIndex={detailRow}
          page={page}
          schema={schema}
          source={activeSource}
          rowLabel={detailLabel}
          onDelete={async () => {
            const rowKey = page.rowKeys?.[detailRow];
            if (rowKey) await mutate([{ op: 'delete', rowKey }]);
          }}
        />
      ) : null}
    </div>
  );
}

const KIND_HINTS: Array<{ icon: typeof Database; label: string; detail: string }> = [
  { icon: Database, label: 'SQLite', detail: '.sqlite · .sqlite3 · .db · .db3' },
  { icon: FileSpreadsheet, label: 'Excel', detail: '.xlsx · .xlsm · .xls' },
  { icon: FileText, label: 'Delimited', detail: '.csv · .tsv' },
];

function EmptyState({
  onOpenPath,
  onBrowse,
}: {
  onOpenPath: (path: string) => Promise<void>;
  onBrowse: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-sm font-semibold tracking-tight">Nothing open yet</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Paste a file or folder path above, or start from a sample. Sheets are treated as tables,
          so every source behaves the same way.
        </p>

        <div className="mt-4 flex flex-col gap-1">
          {KIND_HINTS.map(({ icon: Icon, label, detail }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded border border-border bg-card/40 px-2.5 py-1.5"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-[11px]">{label}</span>
              <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{detail}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onBrowse}>
            Focus path bar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onOpenPath('./fixtures')}
            className="font-mono text-[11px]"
          >
            open ./fixtures
          </Button>
        </div>

        <p className="mt-4 border-t border-border pt-3 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
          or from a terminal: <span className="text-primary/80">dblens ./data</span> — a bare
          <span className="text-primary/80"> dblens </span> gives you a prompt that follows you here.
        </p>
      </div>
    </div>
  );
}
