// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { TeamRole } from '@core/domain/team';
import { cn } from '@ui/lib/cn';

/**
 * Initials chip. The TINT is keyed to role, so "who can do what" is legible at
 * a glance across every surface that shows people.
 *
 * The initials themselves are near-black rather than the role colour, and that
 * is a contrast decision rather than a stylistic one. Role-coloured text on a
 * tint of the same hue measured 4.43:1 — just under AA — and the owner tint is
 * derived from `--brand`, which a DEALER sets, so no fixed value could keep it
 * safe. A dark ink on a light tint passes for any hue a dealer can choose.
 * Colour still carries the role; it is simply no longer carrying the text.
 */

const ROLE_TINTS: Record<TeamRole, string> = {
  owner: 'color-mix(in oklch, var(--brand), transparent 86%)',
  pm: 'color-mix(in oklch, var(--stage-order), transparent 86%)',
  ap: 'color-mix(in oklch, var(--success), transparent 86%)',
  field: 'var(--surface-3)',
};

export function Avatar({
  initials,
  role,
  size = 'md',
  className,
}: {
  initials: string;
  role: TeamRole;
  size?: 'sm' | 'md' | 'lg' | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        size === 'sm' && 'h-7 w-7 text-[10.5px]',
        size === 'md' && 'h-9 w-9 text-[12.5px]',
        size === 'lg' && 'h-11 w-11 text-[15px]',
        className,
      )}
      style={{ background: ROLE_TINTS[role], color: 'var(--text)' }}
    >
      {initials}
    </span>
  );
}
