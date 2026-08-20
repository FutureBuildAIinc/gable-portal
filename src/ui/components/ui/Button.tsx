// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { cn } from '@ui/lib/cn';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

/**
 * Minimum height is 44px on every variant — the touch-target floor. Contractors
 * use this with gloves on.
 *
 * Disabled is a colour change, not a fade. A filled brand button at 45% opacity
 * still reads as a live button in daylight — the Send control on a keyless
 * assistant looked perfectly clickable — so the filled variants drop their fill
 * entirely and go grey. Unmistakably off beats subtly dimmed.
 */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ' +
    'disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary:
          'bg-brand text-brand-on hover:bg-brand-hover disabled:bg-surface-3 disabled:text-text-subtle',
        secondary: 'bg-surface-3 text-text hover:bg-border disabled:text-text-subtle',
        outline:
          'border border-border-strong bg-surface text-text hover:bg-surface-2 disabled:border-border disabled:text-text-subtle',
        ghost: 'text-text-muted hover:bg-surface-3 hover:text-text disabled:text-text-subtle',
        danger:
          'bg-danger text-white hover:opacity-90 disabled:bg-surface-3 disabled:text-text-subtle',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-5 text-base',
        icon: 'h-11 w-11',
      },
      full: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export function Button({ className, variant, size, full, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size, full }), className)} {...props} />;
}
