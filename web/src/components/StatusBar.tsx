import { Database, FileSpreadsheet, FileText, Lock, Server, Timer, Unlock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Source, SourceKind } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<SourceKind, string> = {
  sqlite: 'SQLite',
  excel: 'Excel',
  csv: 'CSV',
  postgres: 'Postgres',
};

const KIND_ICON: Record<SourceKind, LucideIcon> = {
  sqlite: Database,
  excel: FileSpreadsheet,
  csv: FileText,
  postgres: Server,
};

export function StatusBar({
  source,
  objectName,
  total,
  shown,
  offset,
  latencyMs,
}: {
  source: Source | null;
  objectName: string | null;
  total: number;
  shown: number;
  offset: number;
  latencyMs: number | null;
}) {
  if (!source) {
    return (
      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card/60 px-3 font-mono text-[10px] text-muted-foreground">
        <span>ready</span>
        <span className="text-muted-foreground/50">
          paste a path to open a SQLite database, Excel workbook or CSV
        </span>
      </footer>
    );
  }

  const Icon = KIND_ICON[source.kind] ?? Database;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-card/60 px-3 font-mono text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <Icon className="size-3" />
        {KIND_LABEL[source.kind]}
      </span>

      <span className="truncate text-muted-foreground/70" title={source.path}>
        {source.path}
      </span>

      {objectName ? (
        <span className="text-foreground/80">
          {objectName}
          <span className="text-muted-foreground/60">
            {' '}
            · rows {total === 0 ? 0 : formatCount(offset + 1)}–{formatCount(offset + shown)} of{' '}
            {formatCount(total)}
          </span>
        </span>
      ) : null}

      <span className="ml-auto flex items-center gap-3">
        {latencyMs !== null ? (
          <span className="flex items-center gap-1 tabular">
            <Timer className="size-3" />
            {latencyMs} ms
          </span>
        ) : null}
        <span
          className={cn(
            'flex items-center gap-1',
            source.editEnabled ? 'text-warning' : 'text-muted-foreground/60',
          )}
        >
          {source.editEnabled ? <Unlock className="size-3" /> : <Lock className="size-3" />}
          {source.editEnabled ? 'edit' : 'read-only'}
        </span>
      </span>
    </footer>
  );
}
