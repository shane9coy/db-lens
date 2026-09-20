import { cn } from '@/lib/utils';

/**
 * Switch styled after the shadcn primitive, implemented on a native button so
 * the app carries no extra Radix dependency for a single control.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'peer inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors outline-none',
        'focus-visible:ring-[2px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-primary/60 bg-primary/85' : 'border-border bg-muted',
        className,
      )}
    >
      <span
        className={cn(
          'pointer-events-none block size-3 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
