// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { formatCents } from '@core/lib/money';
import type { ScopeLine } from '@core/selectors/order';
import { cn } from '@ui/lib/cn';
import { AlertTriangle, Clock, Minus, Plus, Sparkles } from 'lucide-react';

/**
 * One line of scope.
 *
 * The price treatment is the point: the contractor's price is the number, list
 * is struck through beside it. That contrast is the reason to use a dealer
 * portal instead of a retail site, so it appears on every line rather than in a
 * summary they have to go find.
 */

interface Props {
  line: ScopeLine;
  editable: boolean;
  onQtyChange: (itemId: string, qty: number) => void;
  onOpen: (itemId: string) => void;
}

export function LineItemRow({ line, editable, onQtyChange, onOpen }: Props) {
  const { item } = line;
  const isSpecial = item.kind === 'special';
  const hasPrice = item.unitPrice !== undefined;
  const savings =
    item.listPrice !== undefined && item.unitPrice !== undefined
      ? item.listPrice - item.unitPrice
      : 0;

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex gap-3 px-3 py-3">
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <Thumb line={line} />

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13.5px] font-medium leading-tight">{item.snapshot.name}</p>

            <p className="mt-0.5 flex items-center gap-1.5">
              <span className="text-data text-text-subtle">{item.snapshot.sku}</span>
              {item.addedBy === 'assistant' ? (
                <Sparkles size={11} className="text-brand" strokeWidth={2.5} />
              ) : null}
            </p>

            {/* Your price vs list — the whole value proposition, per line. */}
            <p className="mt-1 flex items-baseline gap-1.5 text-[12px]">
              {hasPrice ? (
                <>
                  <span className="font-medium">{formatCents(item.unitPrice as number)}</span>
                  {savings > 0 ? (
                    <span className="text-text-subtle line-through">
                      {formatCents(item.listPrice as number)}
                    </span>
                  ) : null}
                  <span className="text-text-subtle">/{item.uom}</span>
                  {item.priceSource === 'estimate' ? (
                    <span className="text-warning">est.</span>
                  ) : null}
                </>
              ) : (
                <span className="text-warning">Dealer will price</span>
              )}
            </p>

            {(isSpecial || line.lateForDate || line.breakOpportunity) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {isSpecial ? <Tag tone="warning">Special order</Tag> : null}
                {line.lateForDate ? (
                  <Tag tone="danger">
                    <Clock size={10} strokeWidth={2.5} />
                    {line.leadTimeDays}d lead
                  </Tag>
                ) : null}
                {/* The one piece of pricing mechanics worth surfacing. */}
                {line.breakOpportunity ? (
                  <Tag tone="success">
                    +{line.breakOpportunity.addQty} → {formatCents(line.breakOpportunity.unitPrice)}
                    /{item.uom}
                  </Tag>
                ) : null}
              </div>
            )}
          </div>
        </button>

        <div className="flex shrink-0 flex-col items-end justify-between">
          <p className="text-[14px] font-semibold tabular-nums">
            {hasPrice ? formatCents(line.extended) : '—'}
          </p>

          <QtyStepper
            qty={item.qty}
            disabled={!editable}
            onChange={(qty) => onQtyChange(item.id, qty)}
          />
        </div>
      </div>
    </li>
  );
}

function Thumb({ line }: { line: ScopeLine }) {
  const url = line.item.snapshot.imageUrl;
  if (!url) {
    return (
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface-inset">
        <AlertTriangle size={15} className="text-text-subtle" strokeWidth={2} />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="h-11 w-11 shrink-0 rounded-md border border-border bg-surface-inset object-cover"
    />
  );
}

function QtyStepper({
  qty,
  disabled,
  onChange,
}: {
  qty: number;
  disabled: boolean;
  onChange: (qty: number) => void;
}) {
  if (disabled) {
    return <span className="text-[12px] text-text-muted tabular-nums">qty {qty}</span>;
  }

  return (
    <div className="flex items-center rounded-lg border border-border">
      <StepButton label="Decrease quantity" onClick={() => onChange(qty - 1)}>
        <Minus size={14} strokeWidth={2.5} />
      </StepButton>
      <span className="min-w-9 text-center text-[13px] font-medium tabular-nums">{qty}</span>
      <StepButton label="Increase quantity" onClick={() => onChange(qty + 1)}>
        <Plus size={14} strokeWidth={2.5} />
      </StepButton>
    </div>
  );
}

function StepButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // 36px here rather than 44: the row itself is the large target, and two
      // 44px buttons plus the count would push the row past comfortable height.
      className="flex h-9 w-9 items-center justify-center text-text-muted transition-colors hover:bg-surface-3 hover:text-text"
    >
      {children}
    </button>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: 'warning' | 'danger' | 'success';
  children: React.ReactNode;
}) {
  const color = `var(--${tone})`;
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium')}
      style={{ color, background: `color-mix(in oklch, ${color}, transparent 88%)` }}
    >
      {children}
    </span>
  );
}
