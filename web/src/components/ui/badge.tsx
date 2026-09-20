import { type VariantProps, cva } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded border px-1.5 py-0 font-mono text-[10px] leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted/50 text-muted-foreground',
        primary: 'border-primary/40 bg-primary/12 text-primary',
        outline: 'border-border bg-transparent text-muted-foreground',
        destructive: 'border-destructive/40 bg-destructive/12 text-destructive',
        success: 'border-success/40 bg-success/12 text-success',
        warning: 'border-warning/40 bg-warning/12 text-warning',
        plain: 'border-transparent bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
