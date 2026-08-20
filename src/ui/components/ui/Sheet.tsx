// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '@ui/lib/cn';
import type { ReactNode } from 'react';

/**
 * Bottom sheet on mobile, centred dialog on desktop.
 *
 * Sheets rather than dialogs on phones is a deliberate default: the action
 * lands under the thumb instead of mid-screen, which matters when someone is
 * one-handed in a truck.
 */

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  children?: ReactNode | undefined;
  footer?: ReactNode | undefined;
}

export function Sheet({ open, onOpenChange, title, description, children, footer }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=open]:fade-in',
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed z-50 flex flex-col bg-surface text-text shadow-[var(--shadow-sheet)]',
            // Mobile: bottom sheet, safe-area aware, capped so it never covers everything.
            'inset-x-0 bottom-0 max-h-[88vh] rounded-t-[var(--radius-sheet)]',
            // Desktop: centred dialog.
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(32rem,92vw)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--radius-sheet)]',
          )}
        >
          <div className="shrink-0 px-5 pt-3 pb-2">
            {/* Drag affordance — signals "swipe me away" on touch. */}
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-border-strong sm:hidden" />
            <Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-sm text-text-muted">
                {description}
              </Dialog.Description>
            ) : null}
          </div>

          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">{children}</div>
          ) : null}

          {footer ? (
            <div className="shrink-0 border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
