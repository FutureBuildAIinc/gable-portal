// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { gableStore } from '@core/gable/store';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { Laptop } from 'lucide-react';

/**
 * "This part lives in your browser, not in the supplier's system."
 *
 * The single most important label in the product. Once a portal is wired to a
 * real ERP, a contractor reasonably assumes everything on screen is backed by
 * it — so the pieces that are NOT have to say so, every time, where they are.
 * Silently presenting local state as ERP state is the exact failure this whole
 * integration was correcting; this component is how that correction stays
 * visible rather than living in a README.
 *
 * It renders NOTHING when the portal is standalone. There, everything is local
 * and the connection badge already says so — chipping every panel would be
 * noise that trains people to stop reading chips.
 */

interface Props {
  /** What specifically is local, in the contractor's words. */
  children: React.ReactNode;
  className?: string | undefined;
  /** Inline chip for a heading, or a block note above a panel. */
  variant?: 'chip' | 'note';
}

export function LocalOnly({ children, className, variant = 'chip' }: Props) {
  const status = useStore(gableStore, (state) => state.status);
  if (status === 'standalone') return null;

  if (variant === 'note') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-lg border border-border bg-surface-3 px-3 py-2',
          className,
        )}
      >
        <Laptop size={15} strokeWidth={2} className="mt-0.5 shrink-0 text-text-muted" />
        <p className="text-[12px] text-text-muted">{children}</p>
      </div>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border bg-surface-3 px-2 py-0.5 text-[10.5px] font-medium text-text-muted',
        className,
      )}
    >
      <Laptop size={11} strokeWidth={2.2} />
      {children}
    </span>
  );
}
