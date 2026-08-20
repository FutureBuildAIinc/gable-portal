// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { supplierName } from '@core/config/runtime';
import type { OrderStage } from '@core/domain/project';
import { formatCents } from '@core/lib/money';
import { formatDate } from '@core/lib/time';
import type { BoardCard } from '@core/selectors/board';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { AlertTriangle } from 'lucide-react';

/**
 * The confirmation a cross-stage move goes through.
 *
 * This exists because dragging a card is about to do something in the
 * supplier's system — put work on a person's desk, commit to a purchase. The
 * contractor should never discover that after the fact. Every sheet names the
 * consequence in plain language and prices it.
 *
 * A blocked move renders here too, using the stage machine's own sentence
 * rather than a generic error, so the contractor learns the rule instead of
 * just being stopped.
 */

interface Props {
  card: BoardCard | null;
  target: OrderStage | null;
  /** Rejection reason from the stage machine, if the move is not allowed. */
  blockedReason?: string | null | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  /** Take the remedy the rejection just named, without a second drag. */
  onRedirect?: ((target: OrderStage) => void) | undefined;
}

interface Copy {
  title: string;
  description: string;
  cta: string;
}

function copyFor(target: OrderStage, card: BoardCard): Copy {
  const { totals, order } = card;
  switch (target) {
    case 'quote':
      return {
        title: 'Send to the quote desk',
        description:
          totals.awaitingQuoteCount > 0
            ? `${supplierName()} will price ${totals.awaitingQuoteCount} special-order item${
                totals.awaitingQuoteCount === 1 ? '' : 's'
              } and confirm the rest. You'll get it back as a firm quote.`
            : `${supplierName()} will review this scope and come back with their best pricing.`,
        cta: 'Send to quote desk',
      };
    case 'order':
      return {
        title: 'Place this order',
        description: `This submits a sales order to ${supplierName()} for ${
          order.fulfillment === 'delivery' ? 'delivery' : 'will-call pickup'
        }${order.requestedDate ? ` on ${formatDate(order.requestedDate)}` : ''}.`,
        cta: `Place order — ${formatCents(totals.subtotal)}`,
      };
    case 'plan':
      return {
        title: 'Move back to Plan',
        description:
          card.order.stage === 'quote'
            ? 'This withdraws the order from the quote desk. Any pricing they have started will be discarded.'
            : `This cancels the sales order with ${supplierName()} and reopens the scope for editing.`,
        cta: 'Move to Plan',
      };
    case 'invoice':
      return { title: 'Move to Invoice', description: '', cta: 'Confirm' };
  }
}

export function StageTransitionSheet({
  card,
  target,
  blockedReason,
  onConfirm,
  onCancel,
  onRedirect,
}: Props) {
  const open = card !== null && target !== null;
  if (!card || !target) {
    return <Sheet open={false} onOpenChange={onCancel} title="" />;
  }

  if (blockedReason) {
    // The rejection usually NAMES the fix ("Send this order to the quote
    // desk"). Making them dismiss, re-find the card, and drag again is how a
    // remedy goes untaken on a jobsite — so offer it as a button.
    const remedy =
      target !== 'quote' && card.allowedTargets.includes('quote') && onRedirect ? 'quote' : null;

    return (
      <Sheet
        open={open}
        onOpenChange={(next) => !next && onCancel()}
        title="Can't move this yet"
        footer={
          remedy ? (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onCancel}>
                Got it
              </Button>
              <Button className="flex-[2]" onClick={() => onRedirect?.(remedy)}>
                Send to quote desk
              </Button>
            </div>
          ) : (
            <Button variant="secondary" full onClick={onCancel}>
              Got it
            </Button>
          )
        }
      >
        <div className="flex gap-3 rounded-lg bg-surface-inset p-3">
          <AlertTriangle
            size={18}
            strokeWidth={2}
            className="mt-0.5 shrink-0"
            style={{ color: 'var(--warning)' }}
          />
          {/* The stage machine's own words — the contractor learns the rule. */}
          <p className="text-sm leading-relaxed">{blockedReason}</p>
        </div>
      </Sheet>
    );
  }

  const copy = copyFor(target, card);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={copy.title}
      description={copy.description}
      footer={
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="flex-[2]" onClick={onConfirm}>
            {copy.cta}
          </Button>
        </div>
      }
    >
      <div className="rounded-lg border border-border bg-surface-inset p-3">
        <p className="text-sm font-medium">{card.project.name}</p>
        <p className="text-sm text-text-muted">{card.order.name}</p>

        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Items" value={String(card.totals.itemCount)} />
          <Row label="Your price" value={formatCents(card.totals.subtotal)} />
          {card.totals.savings > 0 ? (
            <Row
              label="Saved vs list"
              value={formatCents(card.totals.savings)}
              valueClass="text-success"
            />
          ) : null}
          {card.totals.awaitingQuoteCount > 0 ? (
            <Row
              label="Awaiting dealer price"
              value={String(card.totals.awaitingQuoteCount)}
              valueClass="text-warning"
            />
          ) : null}
        </dl>
      </div>
    </Sheet>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string | undefined;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
