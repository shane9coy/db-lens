import { Check, Copy, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RowPage, Schema, Source } from '@/lib/api';
import { formatCell, typeTone, valueKind } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function RowDetail({
  open,
  onOpenChange,
  rowIndex,
  page,
  schema,
  source,
  rowLabel,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowIndex: number;
  page: RowPage;
  schema: Schema;
  source: Source;
  rowLabel: string;
  onDelete: () => Promise<void>;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const row = page.rows[rowIndex] ?? [];
  const entries = page.columns.map((column, index) => ({
    column,
    value: row[column.colIndex ?? index],
  }));

  const copy = async (mode: 'json' | 'tsv') => {
    const text =
      mode === 'json'
        ? JSON.stringify(Object.fromEntries(entries.map(({ column, value }) => [column.name, value])), null, 2)
        : entries
            .map(({ value }) => (value === null || value === undefined ? '' : String(value)))
            .join('\t');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(mode);
    } catch {
      setCopied(null);
    }
  };

  const canDelete = source.editEnabled && schema.editable && Boolean(page.rowKeys?.[rowIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {schema.name} · row {rowLabel}
          </DialogTitle>
          <DialogDescription>
            {page.columns.length} fields
            {page.rowKeys?.[rowIndex] ? (
              <span className="ml-2 font-mono text-muted-foreground/70">
                key {page.rowKeys[rowIndex]}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
          {entries.map(({ column, value }, index) => {
            const kind = valueKind(value, column.binary);
            return (
              <div
                key={column.colIndex ?? index}
                className={cn(
                  'flex items-start gap-3 px-3 py-1.5',
                  index % 2 === 1 && 'bg-card/40',
                  index > 0 && 'border-t border-border/60',
                )}
              >
                <div className="flex w-44 shrink-0 items-center gap-1.5">
                  <span className="truncate font-mono text-[11px]" title={column.name}>
                    {column.name}
                  </span>
                  <Badge className={cn('ml-auto shrink-0', typeTone(column.type))}>
                    {column.type || 'any'}
                  </Badge>
                </div>
                <div
                  className={cn(
                    'min-w-0 flex-1 font-mono text-[11px] break-words whitespace-pre-wrap',
                    kind === 'null' && 'text-muted-foreground/50 italic',
                  )}
                >
                  {kind === 'null' ? 'NULL' : formatCell(value, kind)}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          {canDelete ? (
            <Button
              variant="destructive"
              size="sm"
              className="mr-auto"
              onClick={async () => {
                try {
                  await onDelete();
                  onOpenChange(false);
                } catch {
                  // The parent already surfaced the reason. Staying open keeps
                  // the row on screen rather than implying it was removed.
                }
              }}
            >
              <Trash2 />
              Delete row
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void copy('tsv')}>
            {copied === 'tsv' ? <Check className="text-success" /> : <Copy />}
            Copy row
          </Button>
          <Button variant="outline" size="sm" onClick={() => void copy('json')}>
            {copied === 'json' ? <Check className="text-success" /> : <Copy />}
            Copy JSON
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
