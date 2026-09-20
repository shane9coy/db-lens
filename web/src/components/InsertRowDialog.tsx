import { AlertTriangle, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Column, Source } from '@/lib/api';
import { shortType, typeTone } from '@/lib/format';
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

/**
 * New-row form.
 *
 * A bare "insert an empty row" only works on tables where every required
 * column has a default, so this collects values up front and lets the database
 * apply its own defaults for anything left blank.
 */
export function InsertRowDialog({
  open,
  onOpenChange,
  objectName,
  columns,
  source,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objectName: string;
  columns: Column[];
  source: Source;
  onInsert: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    // Pre-fill anything the database already has an answer for.
    setValues(
      Object.fromEntries(
        columns.map((column) => [
          column.name,
          column.default === null || column.default === undefined ? '' : String(column.default),
        ]),
      ),
    );
  }, [open, columns]);

  const required = columns.filter((column) => !column.nullable && column.default == null && !column.pk);

  const submit = async () => {
    const payload: Record<string, unknown> = {};
    for (const column of columns) {
      const raw = values[column.name] ?? '';
      // Blank means "let the database decide" — its default, or NULL.
      if (raw === '') continue;
      payload[column.name] = raw;
    }

    if (Object.keys(payload).length === 0) {
      setError('Fill in at least one column.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onInsert(payload);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Insert failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono">New row in {objectName}</DialogTitle>
          <DialogDescription>
            Leave a field blank to let the source apply its own default.
            {required.length ? (
              <span className="mt-1 flex items-start gap-1.5 text-warning">
                <AlertTriangle className="mt-px size-3 shrink-0" />
                {required.length} column{required.length === 1 ? '' : 's'} need
                {required.length === 1 ? 's' : ''} a value: {required.map((c) => c.name).join(', ')}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 min-h-0 overflow-y-auto rounded border border-border">
          {columns.map((column, index) => (
            <div
              key={column.colIndex ?? index}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5',
                index > 0 && 'border-t border-border/60',
              )}
            >
              <label
                className="flex w-44 shrink-0 items-center gap-1.5"
                htmlFor={`insert-${index}`}
              >
                <span className="truncate font-mono text-[11px]" title={column.name}>
                  {column.name}
                </span>
                <Badge className={cn('ml-auto shrink-0', typeTone(column.type))}>
                  {shortType(column.type)}
                </Badge>
              </label>
              <input
                id={`insert-${index}`}
                value={values[column.name] ?? ''}
                onChange={(event) =>
                  setValues((prev) => ({ ...prev, [column.name]: event.target.value }))
                }
                disabled={column.binary || column.readonly}
                placeholder={
                  column.binary || column.readonly
                    ? 'binary — not editable here'
                    : column.default != null
                      ? `default ${String(column.default)}`
                      : column.nullable
                        ? 'NULL'
                        : 'required'
                }
                spellCheck={false}
                className={cn(
                  'h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-[11px]',
                  'outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring',
                  'disabled:opacity-50',
                )}
              />
            </div>
          ))}
        </div>

        {error ? (
          <p className="flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <span className="mr-auto font-mono text-[10px] text-muted-foreground">
            {source.name} · {objectName}
          </span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            <Plus />
            {busy ? 'Inserting…' : 'Insert row'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
