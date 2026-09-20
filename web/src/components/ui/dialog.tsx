import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/65 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=open]:animate-in" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-3',
          'rounded-lg border border-border bg-popover p-4 shadow-2xl shadow-black/50 outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3 right-3 rounded text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[2px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label="Close"
        >
          <X className="size-3.5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-row justify-end gap-2 pt-1', className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-sm font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn('text-xs leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}
