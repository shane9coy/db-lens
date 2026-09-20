import { Check, Copy, CornerDownLeft, FolderOpen, Loader2, Home } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type DirectoryListing, api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover } from '@/components/ui/popover';

/**
 * Path bar — the in-app half of the "little terminal". Type or paste a file or
 * folder path and it opens; Browse walks the filesystem without a native
 * picker so the same control works in a webview.
 */
export function PathBar({
  onOpenPath,
  busy,
  message,
  focusToken,
}: {
  onOpenPath: (path: string) => Promise<void>;
  busy: boolean;
  message: { kind: 'ok' | 'error'; text: string } | null;
  /** Bumping this focuses the input — lets the rail and header steer you here. */
  focusToken: number;
}) {
  const [value, setValue] = useState('');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusToken === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  // A directory that vanished or is unreadable should say so rather than
  // render as an empty list.
  const load = useCallback(async (dir?: string) => {
    try {
      setListing(await api.browse(dir));
      setListingError(null);
    } catch (err) {
      setListing(null);
      setListingError(err instanceof Error ? err.message : 'Could not read that directory');
    }
  }, []);

  const submit = async () => {
    const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
    if (!trimmed) return;
    await onOpenPath(trimmed);
    setValue('');
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-2 py-2">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-[11px] text-primary/80">
            ›
          </span>
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            spellCheck={false}
            placeholder="/path/to/data.sqlite  ·  ./folder  ·  ~/exports/book.xlsx"
            className={cn(
              'h-8 w-full rounded-md border border-input bg-transparent pr-20 pl-6 font-mono text-[11px]',
              'outline-none placeholder:text-muted-foreground/50',
              'focus-visible:border-ring focus-visible:ring-[2px] focus-visible:ring-ring/40',
            )}
          />
          <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 text-[10px] text-muted-foreground/50">
            <CornerDownLeft className="size-3" />
            open
          </span>
        </div>

        <Button variant="outline" size="sm" onClick={() => void submit()} disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
          Open
        </Button>

        <Popover
          align="end"
          className="w-80"
          trigger={({ open, toggle }) => (
            <Button
              variant={open ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                toggle();
                if (!open) void load(listing?.dir);
              }}
            >
              Browse
            </Button>
          )}
        >
          {({ close }) => (
            <div className="flex max-h-80 flex-col">
              <div className="flex items-center gap-1 border-b border-border pb-1.5">
                <button
                  type="button"
                  className="rounded p-1 hover:bg-accent"
                  title="Home"
                  onClick={async () => {
                    try {
                      const { home } = await api.home();
                      await load(home);
                    } catch {
                      setListingError('Could not resolve the home directory');
                    }
                  }}
                >
                  <Home className="size-3" />
                </button>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {listing?.dir ?? '…'}
                </span>
                {listing?.parent ? (
                  <button
                    type="button"
                    className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] hover:bg-accent"
                    onClick={() => void load(listing.parent ?? undefined)}
                  >
                    up
                  </button>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {listing?.directories.map((dir) => (
                  <button
                    key={dir.path}
                    type="button"
                    onClick={() => void load(dir.path)}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent"
                  >
                    <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-[11px]">{dir.name}</span>
                  </button>
                ))}

                {listing?.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={async () => {
                      await onOpenPath(file.path);
                      close();
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-accent"
                  >
                    <span className="w-8 shrink-0 font-mono text-[9px] text-primary/80 uppercase">
                      {file.ext}
                    </span>
                    <span className="truncate font-mono text-[11px]">{file.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                      {formatBytes(file.size)}
                    </span>
                  </button>
                ))}

                {listingError ? (
                  <p className="px-2 py-3 text-center font-mono text-[10px] break-words text-destructive">
                    {listingError}
                  </p>
                ) : null}

                {listing && !listing.directories.length && !listing.files.length ? (
                  <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
                    Nothing openable here
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </Popover>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy the path of the prompt"
          title="Copy the path in the bar"
          onClick={async () => {
            if (!value.trim()) return;
            try {
              await navigator.clipboard.writeText(value.trim());
              setCopied(true);
            } catch {
              /* clipboard unavailable */
            }
          }}
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>

      {message ? (
        <p
          className={cn(
            'font-mono text-[11px]',
            message.kind === 'ok' ? 'text-success' : 'text-destructive',
          )}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
