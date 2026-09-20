import { AlertTriangle, ChevronDown, Play, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { type RowPage, type Source, api } from '@/lib/api';
import { KIND_CLASS, formatCell, valueKind } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const SAMPLE = 'SELECT * FROM people LIMIT 50';

/**
 * SELECT-only query console. The server validates the statement and runs it on
 * a read-only connection, so anything rejected here would also be rejected
 * there — this panel only surfaces that verdict.
 */
export function SqlConsole({
  source,
  onClose,
}: {
  source: Source;
  onClose: () => void;
}) {
  const [sql, setSql] = useState(SAMPLE);
  const [result, setResult] = useState<RowPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const run = async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setError(null);
    const started = performance.now();
    try {
      setResult(await api.runQuery(source.id, sql, 500));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setElapsed(Math.round(performance.now() - started));
      setRunning(false);
    }
  };

  return (
    <section className="flex shrink-0 flex-col border-t border-border bg-card/50">
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          aria-label={collapsed ? 'Expand console' : 'Collapse console'}
        >
          <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
        </button>
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          SQL
        </span>
        <Badge variant="success" className="gap-1">
          <ShieldCheck className="size-2.5" />
          select only
        </Badge>
        {elapsed !== null ? (
          <span className="font-mono text-[10px] text-muted-foreground tabular">{elapsed} ms</span>
        ) : null}
        {result ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            showing {result.total}
            {result.truncated ? '+' : ''} row{result.total === 1 && !result.truncated ? '' : 's'}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()}>
            <Play />
            {running ? 'Running…' : 'Run'}
            <span className="ml-0.5 font-mono text-[9px] text-primary-foreground/60">⌘↵</span>
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close console"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {collapsed ? null : (
        <>
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void run();
              }
            }}
            spellCheck={false}
            rows={3}
            className={cn(
              'mx-2 mb-1.5 resize-y rounded-md border border-input bg-background/60 px-2 py-1.5',
              'font-mono text-[11px] leading-relaxed outline-none',
              'placeholder:text-muted-foreground/50 focus-visible:border-ring',
            )}
            placeholder="SELECT * FROM …"
          />

          {error ? (
            <p className="mx-2 mb-1.5 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              {error}
            </p>
          ) : null}

          {result && !error ? (
            <div className="mx-2 mb-2 max-h-56 overflow-auto rounded border border-border">
              <table className="w-full border-collapse">
                <thead className="sticky top-0 bg-card">
                  <tr>
                    {result.columns.map((column) => (
                      <th
                        key={column.name}
                        className="border-b border-border px-2 py-1 text-left font-mono text-[10px] font-medium whitespace-nowrap text-muted-foreground"
                      >
                        {column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="hover:bg-accent/30">
                      {result.columns.map((column, columnIndex) => {
                        const value = row[columnIndex];
                        const kind = valueKind(value, column.binary);
                        return (
                          <td
                            key={column.name}
                            className={cn(
                              'border-b border-border/40 px-2 py-0.5 font-mono text-[11px] whitespace-nowrap',
                              KIND_CLASS[kind],
                            )}
                          >
                            {kind === 'null' ? 'NULL' : formatCell(value, kind)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
