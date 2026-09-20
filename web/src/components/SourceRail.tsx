import {
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  FileSpreadsheet,
  FileText,
  Lock,
  Plus,
  Server,
  Table2,
  Trash2,
  Unlock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Source, SourceKind, SourceObject } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<SourceKind, LucideIcon> = {
  sqlite: Database,
  excel: FileSpreadsheet,
  csv: FileText,
  postgres: Server,
};

export function SourceRail({
  sources,
  objects,
  activeSourceId,
  activeObject,
  objectsLoading,
  expanded,
  onToggleExpanded,
  onSelectSource,
  onSelectObject,
  onRemoveSource,
  onRequestOpen,
  onToggleEdit,
}: {
  sources: Source[];
  objects: SourceObject[];
  activeSourceId: number | null;
  activeObject: string | null;
  objectsLoading: boolean;
  expanded: Record<number, boolean>;
  onToggleExpanded: (id: number) => void;
  onSelectSource: (source: Source) => void;
  onSelectObject: (name: string) => void;
  onRemoveSource: (source: Source) => void;
  onRequestOpen: () => void;
  onToggleEdit: (source: Source, enabled: boolean) => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Sources
        </span>
        <span className="font-mono text-[10px] text-muted-foreground/60">{sources.length}</span>
        <button
          type="button"
          onClick={onRequestOpen}
          title="Open a file or folder"
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sources.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground">Nothing open</p>
            <button
              type="button"
              onClick={onRequestOpen}
              className="mt-2 text-[11px] text-primary hover:underline"
            >
              Open a file or folder
            </button>
          </div>
        ) : null}

        {sources.map((source) => {
          const Icon = KIND_ICON[source.kind] ?? Database;
          const isActive = source.id === activeSourceId;
          const isOpen = expanded[source.id] ?? isActive;

          return (
            <div key={source.id} className="px-1">
              <div
                className={cn(
                  'group flex items-center gap-1.5 rounded px-1.5 py-1',
                  isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                )}
              >
                <button
                  type="button"
                  onClick={() => onToggleExpanded(source.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                >
                  {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                </button>

                <button
                  type="button"
                  onClick={() => onSelectSource(source)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  title={source.path}
                >
                  <Icon
                    className={cn(
                      'size-3.5 shrink-0',
                      !source.exists
                        ? 'text-destructive'
                        : isActive
                          ? 'text-primary'
                          : 'text-muted-foreground',
                    )}
                  />
                  <span
                    className={cn(
                      'truncate text-xs',
                      !source.exists && 'text-destructive line-through decoration-destructive/50',
                    )}
                  >
                    {source.name}
                  </span>
                  {!source.exists ? (
                    <span className="shrink-0 font-mono text-[9px] text-destructive">gone</span>
                  ) : null}
                </button>

                {/* Sibling of the select button, not a child — nesting buttons
                    is invalid, and this needs its own click target. */}
                {source.exists && source.canEdit ? (
                  <button
                    type="button"
                    onClick={() => onToggleEdit(source, !source.editEnabled)}
                    aria-pressed={source.editEnabled}
                    aria-label={`${source.editEnabled ? 'Lock' : 'Unlock'} ${source.name}`}
                    title={
                      source.editEnabled
                        ? 'Edit mode on — click to make read-only'
                        : 'Read-only — click to allow edits'
                    }
                    className="shrink-0 rounded p-0.5 hover:bg-accent"
                  >
                    {source.editEnabled ? (
                      <Unlock className="size-3 text-warning" />
                    ) : (
                      <Lock className="size-3 text-muted-foreground/50" />
                    )}
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => onRemoveSource(source)}
                  title="Remove from the list"
                  aria-label={`Remove ${source.name}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>

              {isOpen ? (
                <div className="mt-0.5 mb-1 ml-4 border-l border-border/70 pl-1.5">
                  {objectsLoading && isActive ? (
                    <p className="px-2 py-1 text-[11px] text-muted-foreground">loading…</p>
                  ) : null}
                  {isActive && !objectsLoading && objects.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] text-muted-foreground">no tables</p>
                  ) : null}

                  {isActive
                    ? objects.map((object) => {
                        const selected = object.name === activeObject;
                        const isView = object.type === 'view';
                        return (
                          <button
                            key={object.name}
                            type="button"
                            onClick={() => onSelectObject(object.name)}
                            title={
                              isView
                                ? `${object.name} · view (read-only)`
                                : `${object.name} · ${object.type}`
                            }
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left',
                              selected
                                ? 'bg-primary/15 text-foreground'
                                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                            )}
                          >
                            {isView ? (
                              <Eye className="size-3 shrink-0 opacity-70" />
                            ) : (
                              <Table2 className="size-3 shrink-0 opacity-70" />
                            )}
                            <span className="truncate font-mono text-[11px]">{object.name}</span>
                            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular">
                              {object.rowCountEstimated ? '~' : ''}
                              {formatCount(object.rowCount)}
                            </span>
                          </button>
                        );
                      })
                    : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
