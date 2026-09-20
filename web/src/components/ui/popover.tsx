import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Minimal anchored popover — click-outside and Escape to dismiss.
 * Radix would work but a data grid already carries enough dependencies.
 */
export function Popover({
  trigger,
  children,
  align = 'start',
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (props: { close: () => void }) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open ? (
        <div
          role="dialog"
          className={cn(
            'absolute top-full z-40 mt-1 min-w-44 rounded-md border border-border bg-popover p-1.5 shadow-xl shadow-black/40',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      ) : null}
    </div>
  );
}
