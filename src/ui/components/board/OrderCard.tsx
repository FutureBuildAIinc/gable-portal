// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { hasKnownSubtotal } from '@core/domain/totals';
import { formatCents } from '@core/lib/money';
import { daysBetween, formatDate } from '@core/lib/time';
import type { BoardCard } from '@core/selectors/board';
import { cn } from '@ui/lib/cn';
import { AlertTriangle, Clock, MapPin, Store, Truck } from 'lucide-react';
import { STAGE_VAR } from './stageStyles';

/**
 * The board card. Everything a contractor needs to triage an order in about a
 * second, and nothing else.
 *
 * The hierarchy is deliberate: project name reads first (that's how a
 * contractor thinks about their work), the order name second, money right-
 * aligned in tabular figures so a column of cards scans vertically. Warnings
 * only appear when they are true — a card with no chips is a card with nothing
 * wrong, which is information in itself.
 */

interface OrderCardProps {
  card: BoardCard;
  now: string;
  onOpen?: ((orderId: string) => void) | undefined;
  dragging?: boolean | undefined;
  className?: string | undefined;
  /**
   * dnd-kit's drag attributes and listeners, applied to the card ITSELF.
   *
   * They used to sit on a wrapper div, which gave that div role="button" while
   * the card inside was also a button — nested interactive controls, which a
   * screen reader cannot present sensibly and axe flags as serious. One
   * element is both the open target and the drag source.
   */
  // biome-ignore lint/suspicious/noExplicitAny: dnd-kit's attribute bag is untyped
  dragProps?: Record<string, any> | undefined;
}

export function OrderCard({ card, now, onOpen, dragging, className, dragProps }: OrderCardProps) {
  const { order, project, totals, maxLeadTimeDays } = card;

  const daysToDate = order.requestedDate ? daysBetween(now, order.requestedDate) : null;
  // The lead-time warning that justifies the whole feature: the slowest line
  // cannot physically arrive by the date the contractor asked for.
  const leadTimeRisk = daysToDate !== null && daysToDate >= 0 && maxLeadTimeDays > daysToDate;

  return (
    <article
      onClick={onOpen ? () => onOpen(order.id) : undefined}
      {...(onOpen ? { role: 'button', tabIndex: 0 } : {})}
      {...dragProps}
      /**
       * Composed, and spread LAST on purpose.
       *
       * dnd-kit's listeners include their own onKeyDown, and because dragProps
       * is spread after this element's own handlers it used to replace them
       * outright — so a keyboard user could start a drag but could not open an
       * order at all. Enter opens; Space is left to dnd-kit, which is what its
       * own screen-reader instructions already say ("press space bar to pick
       * up"). Two keys, two jobs, both announced.
       */
      onKeyDown={(event) => {
        if (onOpen && event.key === 'Enter') {
          event.preventDefault();
          onOpen(order.id);
          return;
        }
        dragProps?.onKeyDown?.(event);
      }}
      className={cn(
        'relative w-full overflow-hidden rounded-[var(--radius-card)] border border-border',
        'bg-surface text-left shadow-[var(--shadow-card)] transition-shadow',
        onOpen && 'cursor-pointer hover:shadow-[var(--shadow-lifted)]',
        dragging && 'shadow-[var(--shadow-lifted)]',
        className,
      )}
    >
      {/* Stage rail — colour-codes the card even when it's mid-drag. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: STAGE_VAR[order.stage] }}
      />

      <div className="py-3 pl-4 pr-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight">{project.name}</p>
            <p className="truncate text-[13px] leading-tight text-text-muted">{order.name}</p>
          </div>
          <div className="shrink-0 text-right">
            {/* An empty draft has no price — a confident $0.00 in the money
                slot reads as "an order worth nothing", which is a lie. */}
            <p className="text-[15px] font-semibold leading-tight">
              {hasKnownSubtotal(totals) ? (
                formatCents(totals.subtotal)
              ) : (
                <span className="font-normal text-text-subtle">—</span>
              )}
            </p>
            {totals.savings > 0 ? (
              <p className="text-[11px] leading-tight text-success">
                saved {formatCents(totals.savings)}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 text-[11px] text-text-subtle">
          {/* shrink-0 + nowrap: in a narrow desktop column this was wrapping
              mid-value to "Aug / 12" and "No / date", which reads as two
              separate facts rather than one date. The city truncates instead —
              a shortened place name is still legible, half a date is not. */}
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
            {order.fulfillment === 'delivery' ? (
              <Truck size={12} strokeWidth={2} />
            ) : (
              <Store size={12} strokeWidth={2} />
            )}
            {order.requestedDate ? formatDate(order.requestedDate) : 'No date'}
          </span>
          <span className="inline-flex items-center gap-1 truncate">
            <MapPin size={12} strokeWidth={2} />
            <span className="truncate">{project.address?.city ?? '—'}</span>
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
            {/* Real product photos: "the decking order" is recognised faster
                by picture than by two lines of truncated text. */}
            {card.thumbUrls.length > 0 ? (
              <span className="flex -space-x-1.5">
                {card.thumbUrls.map((url) => (
                  <img
                    key={url}
                    src={url}
                    alt=""
                    className="h-6 w-6 rounded-full border border-border bg-white object-cover"
                  />
                ))}
              </span>
            ) : null}
            {totals.itemCount === 0
              ? 'empty — add materials'
              : `${totals.itemCount} item${totals.itemCount === 1 ? '' : 's'}`}
          </span>
        </div>

        {(totals.awaitingQuoteCount > 0 || leadTimeRisk || card.supplierStatus) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {/* What Gable is doing right now — the board reads as live. */}
            {card.supplierStatus ? (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium"
                style={{
                  color: card.supplierDone ? 'var(--success)' : 'var(--info)',
                  background: card.supplierDone
                    ? 'color-mix(in oklch, var(--success), transparent 86%)'
                    : 'color-mix(in oklch, var(--info), transparent 86%)',
                }}
              >
                {card.supplierDone ? '✓' : '•'} {card.supplierStatus}
              </span>
            ) : null}
            {totals.awaitingQuoteCount > 0 ? (
              <Chip tone="warning" icon={<AlertTriangle size={11} strokeWidth={2.5} />}>
                {totals.awaitingQuoteCount} need{totals.awaitingQuoteCount === 1 ? 's' : ''} pricing
              </Chip>
            ) : null}
            {leadTimeRisk ? (
              <Chip tone="danger" icon={<Clock size={11} strokeWidth={2.5} />}>
                {/* Say the consequence, not the arithmetic. */}
                Can't make {order.requestedDate ? formatDate(order.requestedDate) : 'the date'} —{' '}
                {maxLeadTimeDays}d lead
              </Chip>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

function Chip({
  tone,
  icon,
  children,
}: {
  tone: 'warning' | 'danger';
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'danger' && 'bg-danger/15 text-danger',
      )}
      style={{
        color: tone === 'warning' ? 'var(--warning)' : 'var(--danger)',
        background:
          tone === 'warning'
            ? 'color-mix(in oklch, var(--warning), transparent 86%)'
            : 'color-mix(in oklch, var(--danger), transparent 86%)',
      }}
    >
      {icon}
      {children}
    </span>
  );
}
