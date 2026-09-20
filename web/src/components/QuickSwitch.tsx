import {
  Database,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Search,
  Table2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Source, type SourceKind, type SourceObject, api } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const KIND_ICON: Record<SourceKind, LucideIcon> = {
  sqlite: Database,
  excel: FileSpreadsheet,
  csv: FileText,
};

interface Entry {
  source: Source;
  object: SourceObject;
}

/**
 * ⌘K table switcher — pulls the object list for every open source so a table
 * can be reached without walking the rail. Object lists are fetched when the
 * dialog opens, never upfront.
 */
export function QuickSwitch({
  open,
  onOpenChange,
  sources,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
  onPick: (source: Source, object: SourceObject) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery('');
    setCursor(0);
    setLoading(true);

    void Promise.all(
      sources
        .filter((source) => source.exists)
        .map(async (source) => {
          try {
            const { objects } = await api.listObjects(source.id);
            return objects.map((object) => ({ source, object }));
          } catch {
            return [];
          }
        }),
    )
      .then((groups) => {
        if (!cancelled) setEntries(groups.flat());
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, sources]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? entries.filter(
          (entry) =>
            entry.object.name.toLowerCase().includes(needle) ||
            entry.source.name.toLowerCase().includes(needle),
        )
      : entries;
    return list.slice(0, 300);
  }, [entries, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    onPick(entry.source, entry.object);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] max-w-xl translate-y-0 gap-2 p-3">
        <DialogHeader className="sr-only">
          <DialogTitle>Jump to table</DialogTitle>
          <DialogDescription>Search every open source for a table or sheet.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, matches.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                pick(matches[cursor]);
              }
            }}
            placeholder="Jump to a table or sheet…"
            spellCheck={false}
            className="h-9 w-full rounded-md border border-input bg-transparent pr-3 pl-8 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring"
          />
          {loading ? (
            <Loader2 className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>

        <div ref={listRef} className="max-h-80 min-h-0 overflow-y-auto">
          {matches.length === 0 && !loading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {entries.length === 0 ? 'No open sources' : 'Nothing matches'}
            </p>
          ) : null}

          {matches.map((entry, index) => {
            const Icon = KIND_ICON[entry.source.kind] ?? Database;
            return (
              <button
                key={`${entry.source.id}:${entry.object.name}`}
                type="button"
                data-active={index === cursor}
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(entry)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
                  index === cursor ? 'bg-primary/15' : 'hover:bg-accent/50',
                )}
              >
                {entry.object.type === 'view' ? (
                  <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-[11px]">{entry.object.name}</span>
                <span className="ml-1 flex shrink-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/60">
                  <Icon className="size-2.5" />
                  {entry.source.name}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular">
                  {formatCount(entry.object.rowCount)}
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
