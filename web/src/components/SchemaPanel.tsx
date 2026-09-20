import { AlertTriangle, Eye, KeyRound, Link2, Table2, X, Zap } from 'lucide-react';
import { useState } from 'react';
import type { Schema, Source } from '@/lib/api';
import { formatCount, shortType, typeTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

export function SchemaPanel({
  source,
  schema,
  hasHeader,
  onToggleHeader,
  onClose,
  onToggleEdit,
}: {
  source: Source;
  schema: Schema;
  /** Spreadsheets only: whether row 1 is treated as the column names. */
  hasHeader: boolean;
  onToggleHeader: (value: boolean) => void;
  onClose: () => void;
  onToggleEdit: (enabled: boolean) => void;
}) {
  const [showDdl, setShowDdl] = useState(false);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        {schema.type === 'view' ? (
          <Eye className="size-3.5 text-muted-foreground" />
        ) : (
          <Table2 className="size-3.5 text-muted-foreground" />
        )}
        <span className="truncate font-mono text-[11px]">{schema.name}</span>
        <Badge variant="outline" className="shrink-0">
          {schema.type}
        </Badge>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide schema"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2">
          <div>
            <p className="font-mono text-sm tabular">{formatCount(schema.rowCount)}</p>
            <p className="text-[10px] text-muted-foreground">rows</p>
          </div>
          <div>
            <p className="font-mono text-sm tabular">{schema.columnCount}</p>
            <p className="text-[10px] text-muted-foreground">columns</p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-mono text-[11px]">
              {schema.editable ? (
                <span className="text-success">writable</span>
              ) : (
                <span className="text-muted-foreground">read-only</span>
              )}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground/70">
              {schema.rowIdentity === 'none' ? 'no key' : `key: ${schema.rowIdentity}`}
            </p>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch
              checked={source.editEnabled}
              onCheckedChange={onToggleEdit}
              disabled={!source.canEdit || !schema.editable}
              aria-label="Enable editing"
            />
            <span className={cn('text-[11px]', source.editEnabled ? 'text-warning' : 'text-muted-foreground')}>
              {source.editEnabled ? 'Edit mode on' : 'Read-only'}
            </span>
          </label>
          {source.kind !== 'sqlite' ? (
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <Switch
                checked={hasHeader}
                onCheckedChange={onToggleHeader}
                aria-label="Treat the first row as the column names"
              />
              <span className="text-[11px] text-muted-foreground">First row is the header</span>
            </label>
          ) : null}
          {!schema.editable ? (
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {schema.type === 'view'
                ? 'Views have no row identity, so writes are disabled.'
                : 'This table has no rowid or primary key, so writes are disabled.'}
            </p>
          ) : null}
          {schema.writeCaveat && source.editEnabled ? (
            <p className="mt-1.5 flex gap-1.5 text-[10px] leading-relaxed text-warning">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              <span>{schema.writeCaveat}</span>
            </p>
          ) : null}
        </div>

        <section className="border-b border-border">
          <h3 className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Columns
          </h3>
          <div className="pb-2">
            {schema.columns.map((column) => (
              <div key={column.name} className="flex items-center gap-1.5 px-3 py-1 hover:bg-accent/35">
                {column.pk ? (
                  <KeyRound className="size-3 shrink-0 text-warning" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className="truncate font-mono text-[11px]" title={column.header ?? column.name}>
                  {column.name}
                </span>
                {!column.nullable ? (
                  <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">not null</span>
                ) : null}
                <Badge className={cn('ml-auto shrink-0', typeTone(column.type))}>
                  {column.type ? shortType(column.type) : 'any'}
                </Badge>
              </div>
            ))}
          </div>
        </section>

        {schema.indexes.length ? (
          <section className="border-b border-border">
            <h3 className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Indexes
            </h3>
            <div className="pb-2">
              {schema.indexes.map((index) => (
                <div key={index.name} className="px-3 py-1 hover:bg-accent/35">
                  <div className="flex items-center gap-1.5">
                    {index.unique ? (
                      <Zap className="size-3 shrink-0 text-success" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="truncate font-mono text-[11px]">{index.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/70">
                      {index.origin}
                    </span>
                  </div>
                  <p className="pl-4.5 font-mono text-[10px] text-muted-foreground/70">
                    ({index.columns.join(', ')})
                  </p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {schema.foreignKeys.length ? (
          <section className="border-b border-border">
            <h3 className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              References
            </h3>
            <div className="pb-2">
              {schema.foreignKeys.map((fk, i) => (
                <div
                  key={`${fk.column}-${i}`}
                  className="flex items-center gap-1.5 px-3 py-1 hover:bg-accent/35"
                >
                  <Link2 className="size-3 shrink-0 text-primary/80" />
                  <span className="truncate font-mono text-[11px]">{fk.column}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    → {fk.refTable}.{fk.refColumn ?? '?'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {schema.ddl ? (
          <section className="border-b border-border">
            <button
              type="button"
              onClick={() => setShowDdl((v) => !v)}
              className="w-full px-3 pt-2.5 pb-1 text-left text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase hover:text-foreground"
            >
              {showDdl ? '▾' : '▸'} Definition
            </button>
            {showDdl ? (
              <pre className="mx-2 mb-2 max-h-72 overflow-auto rounded border border-border bg-background/60 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {schema.ddl}
              </pre>
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
