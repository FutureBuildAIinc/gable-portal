// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  addLaborLine,
  buildCustomerQuote,
  quoteForOrder,
  removeLaborLine,
  reviseCustomerQuote,
  sendCustomerQuote,
  supplierPriceHorizon,
  updateCustomerQuote,
} from '@core/actions/customer-quote';
import { activeMember, teamMembers } from '@core/actions/team';
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { computeQuoteTotals, laborTotal } from '@core/domain/customer-quote';
import { can } from '@core/domain/team';
import { formatCents, toCents } from '@core/lib/money';
import { daysBetween, formatDate } from '@core/lib/time';
import { teamStore } from '@core/stores/root';
import { customerQuotesStore, ordersStore } from '@core/stores/root';
import { Button } from '@ui/components/ui/Button';
import { useStore } from '@ui/hooks/useStore';
import { AlertTriangle, ChevronLeft, Copy, Eye, Minus, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';

/**
 * Where the contractor's margin is set.
 *
 * The margin card is always visible while they move the markup slider, because
 * this is the one screen where the number that matters is theirs, not the
 * supplier's.
 */

interface Props {
  orderId: string;
  onBack: () => void;
}

export function QuoteStudioPage({ orderId, onBack }: Props) {
  useStore(customerQuotesStore, (state) => state);
  useStore(teamStore, (state) => state);
  const orders = useStore(ordersStore, (state) => state);
  const acting = activeMember();
  /**
   * Capability, not just stage. These controls used to be disabled only by
   * quote status, so for A/P and Field the slider snapped back and the name
   * field swallowed keystrokes with no explanation — the refusal sentence
   * naming who CAN do it was computed and thrown away.
   */
  const mayQuote = acting ? can(acting.role, 'customer-quote') : true;
  const [toast, setToast] = useState<string | null>(null);

  const now = getContext().clock.nowIso();
  const order = orders.byId[orderId];
  const quote = quoteForOrder(orderId);

  /** A gated action's refusal must never be discarded — it names who can act. */
  function flashIfRefused(result: { ok: boolean; error?: string }) {
    if (!result.ok && result.error) flash(result.error);
  }

  function flash(message: string) {
    setToast(message);
    setTimeout(() => setToast(null), 3200);
  }

  if (!order) {
    return <p className="p-8 text-center text-sm text-text-subtle">That order no longer exists.</p>;
  }

  if (!quote) {
    return (
      <Wrapper onBack={onBack} title="Customer quote">
        <div className="p-6 text-center">
          <p className="text-sm text-text-muted">
            Build a branded proposal for {order.name} with your markup, labor, and overhead.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              const result = buildCustomerQuote(orderId);
              if (!result.ok) flash(result.error);
            }}
          >
            Build customer quote
          </Button>
        </div>
        {toast ? <Toast>{toast}</Toast> : null}
      </Wrapper>
    );
  }

  const totals = computeQuoteTotals(quote);
  const horizon = supplierPriceHorizon(orderId);
  const cappedByHorizon = horizon !== undefined && quote.validUntil === horizon;
  const shareUrl = quote.shareToken ? `${window.location.origin}/q/${quote.shareToken}` : null;
  // A sent quote is live under the homeowner's link, so its numbers are frozen
  // here too. Revise takes the old link down and reopens editing.
  const editable = quote.status === 'draft' && mayQuote;

  return (
    <Wrapper onBack={onBack} title={order.name} subtitle={quote.number}>
      <div className="space-y-5 p-4 pb-44">
        {!mayQuote ? (
          <section className="rounded-[var(--radius-card)] bg-surface-inset p-3">
            <p className="text-[12.5px] leading-relaxed text-text-muted">
              Customer quotes are built by{' '}
              {teamMembers()
                .filter((member) => can(member.role, 'customer-quote'))
                .map((member) => member.name)
                .join(' or ') || 'the owner'}
              . Switch people from the header to make changes.
            </p>
          </section>
        ) : null}
        {!editable && quote.status !== 'accepted' ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface-inset p-4">
            <p className="text-[13px] leading-relaxed text-text-muted">
              This proposal is with {quote.customer.name || 'your customer'} — what the link shows
              is what you sent. To change it, revise it first; the old link goes dead the moment you
              do.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => {
                const result = reviseCustomerQuote(quote.id);
                flash(result.ok ? 'Back to draft — the old link is dead' : result.error);
              }}
            >
              Revise this quote
            </Button>
          </section>
        ) : null}

        {/* Margin — the number that matters here. */}
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[12.5px] text-text-muted">Your cost</span>
            <span className="text-[14px] tabular-nums">{formatCents(totals.materialCost)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[12.5px] text-text-muted">Customer pays</span>
            <span className="text-[15px] tabular-nums">{formatCents(totals.grand)}</span>
          </div>
          {/* The number this screen exists for gets the largest type, and a
              thin margin warns with a shape as well as a colour — hue alone
              fails in sun and for colour-blind eyes. */}
          <div
            className="mt-2 flex items-baseline justify-between border-border border-t pt-2"
            style={{ color: totals.marginPercent < 15 ? 'var(--warning)' : 'var(--success)' }}
          >
            <span className="inline-flex items-center gap-1.5 font-medium text-[12.5px]">
              {totals.marginPercent < 15 ? <AlertTriangle size={14} strokeWidth={2.5} /> : null}
              Gross margin
            </span>
            <span className="font-semibold text-[20px] tabular-nums">
              {formatCents(totals.margin)} · {totals.marginPercent}%
            </span>
          </div>
        </section>

        <section>
          <label htmlFor="markup" className="mb-1.5 flex items-baseline justify-between">
            <span className="font-medium text-[13px]">Material markup</span>
            <span className="font-semibold text-[15px] tabular-nums">{quote.markupPercent}%</span>
          </label>
          {/* A 15px slider thumb is not a glove target, so the fine moves
              live on 44px steppers and the slider handles coarse ones. */}
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="secondary"
              aria-label="Lower markup one percent"
              disabled={!editable || quote.markupPercent <= 0}
              onClick={() =>
                updateCustomerQuote(quote.id, {
                  markupPercent: Math.max(0, quote.markupPercent - 1),
                })
              }
            >
              <Minus size={17} strokeWidth={2.5} />
            </Button>
            <input
              id="markup"
              type="range"
              min={0}
              max={60}
              value={quote.markupPercent}
              disabled={!editable}
              onChange={(event) =>
                flashIfRefused(
                  updateCustomerQuote(quote.id, { markupPercent: Number(event.target.value) }),
                )
              }
              className="min-w-0 flex-1 accent-[var(--brand)]"
            />
            <Button
              size="icon"
              variant="secondary"
              aria-label="Raise markup one percent"
              disabled={!editable || quote.markupPercent >= 60}
              onClick={() =>
                updateCustomerQuote(quote.id, {
                  markupPercent: Math.min(60, quote.markupPercent + 1),
                })
              }
            >
              <Plus size={17} strokeWidth={2.5} />
            </Button>
          </div>
        </section>

        {/* Expiry, and the cap that protects the contractor. */}
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="font-medium text-[13px]">Valid until</p>
          <p className="mt-0.5 text-[13px] text-text-muted">
            {formatDate(quote.validUntil)} · {daysBetween(now, quote.validUntil)} days
          </p>
          {cappedByHorizon ? (
            <p className="mt-2 flex gap-2 rounded-lg bg-surface-inset p-2.5 text-[12px] leading-relaxed text-text-muted">
              <AlertTriangle
                size={14}
                strokeWidth={2}
                className="mt-0.5 shrink-0"
                style={{ color: 'var(--warning)' }}
              />
              Capped by {supplierName()}'s pricing, which expires {formatDate(horizon as string)}.
              Offering longer would leave you exposed if their price moves.
            </p>
          ) : null}
        </section>

        <LaborSection
          quoteId={quote.id}
          lines={quote.laborLines}
          onFlash={flash}
          editable={editable}
        />

        <section>
          <label className="block">
            <span className="mb-1 block font-medium text-[13px]">Customer name</span>
            <input
              value={quote.customer.name}
              disabled={!editable}
              onChange={(event) =>
                flashIfRefused(
                  updateCustomerQuote(quote.id, {
                    customer: { ...quote.customer, name: event.target.value },
                  }),
                )
              }
              className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-brand"
            />
          </label>
        </section>

        {/* Selections vs commodities, so the contractor knows what the customer will see. */}
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
          <p className="font-medium text-[13px]">What your customer sees</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">
            <strong>{quote.lines.filter((l) => l.presentation === 'selection').length}</strong>{' '}
            selections shown with photos and full product details;{' '}
            <strong>{quote.lines.filter((l) => l.presentation === 'commodity').length}</strong>{' '}
            structural items summarised. Your cost never appears.
          </p>
        </section>

        {shareUrl ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
            <p className="font-medium text-[13px]">Share link</p>
            <p className="mt-1 break-all text-[11.5px] text-text-subtle">{shareUrl}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(shareUrl);
                  flash('Link copied');
                }}
              >
                <Copy size={14} strokeWidth={2} />
                Copy
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.open(shareUrl, '_blank')}>
                <Eye size={14} strokeWidth={2} />
                Preview
              </Button>
            </div>
            <p className="mt-2 text-[11.5px] text-text-subtle">
              {quote.status === 'accepted'
                ? `Accepted by ${quote.acceptance?.signedName}`
                : quote.viewCount > 0
                  ? `Opened ${quote.viewCount} time${quote.viewCount === 1 ? '' : 's'}`
                  : 'Not opened yet'}
            </p>
          </section>
        ) : null}
      </div>

      <div className="fixed inset-x-0 bottom-16 z-20 border-border border-t bg-surface/95 p-3 backdrop-blur lg:bottom-0 lg:left-60">
        <Button
          full
          size="lg"
          disabled={!editable}
          onClick={() => {
            const result = sendCustomerQuote(quote.id);
            flash(result.ok ? `Sent to ${result.value.customer.name}` : result.error);
          }}
        >
          <Send size={16} strokeWidth={2} />
          {quote.shareToken ? 'Re-send with a new link' : 'Send to customer'}
        </Button>
      </div>

      {toast ? <Toast>{toast}</Toast> : null}
    </Wrapper>
  );
}

function LaborSection({
  quoteId,
  lines,
  onFlash,
  editable,
}: {
  quoteId: string;
  lines: {
    id: string;
    description: string;
    rateType: 'hourly' | 'flat';
    rate: number;
    hours?: number;
  }[];
  onFlash: (message: string) => void;
  editable: boolean;
}) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  return (
    <section>
      <p className="mb-1.5 font-medium text-[13px]">Labor &amp; services</p>

      {lines.length > 0 ? (
        <ul className="mb-2 divide-y divide-border rounded-[var(--radius-card)] border border-border">
          {lines.map((line) => (
            <li key={line.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px]">{line.description}</span>
              <span className="text-[13px] tabular-nums">{formatCents(laborTotal(line))}</span>
              <button
                type="button"
                aria-label={`Remove ${line.description}`}
                disabled={!editable}
                onClick={() => {
                  const result = removeLaborLine(quoteId, line.id);
                  if (!result.ok) onFlash(result.error);
                }}
                className="text-text-subtle hover:text-danger disabled:opacity-40"
              >
                <Trash2 size={14} strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <input
          value={description}
          disabled={!editable}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Framing labor"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-brand disabled:opacity-50"
        />
        <input
          value={amount}
          disabled={!editable}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="min-h-11 w-24 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-brand disabled:opacity-50"
        />
        <Button
          size="md"
          variant="secondary"
          aria-label="Add labor line"
          disabled={!editable}
          onClick={() => {
            const value = Number(amount);
            if (!description.trim() || !Number.isFinite(value) || value <= 0) {
              onFlash('Add a description and an amount.');
              return;
            }
            const added = addLaborLine(quoteId, {
              description: description.trim(),
              rateType: 'flat',
              rate: toCents(value),
            });
            if (!added.ok) {
              onFlash(added.error);
              return;
            }
            setDescription('');
            setAmount('');
          }}
        >
          <Plus size={16} strokeWidth={2.5} />
        </Button>
      </div>
    </section>
  );
}

function Wrapper({
  onBack,
  title,
  subtitle,
  children,
}: {
  onBack: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="border-border border-b bg-surface px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-text-muted hover:text-text"
        >
          <ChevronLeft size={15} strokeWidth={2.5} />
          Order
        </button>
        <h2 className="font-semibold text-[19px] tracking-tight">{title}</h2>
        {subtitle ? <p className="text-data text-[12.5px] text-text-muted">{subtitle}</p> : null}
      </header>
      {children}
    </>
  );
}

function Toast({ children }: { children: React.ReactNode }) {
  return (
    <output className="fixed inset-x-4 bottom-32 z-40 block rounded-lg bg-text px-4 py-3 text-sm text-surface shadow-[var(--shadow-lifted)] lg:inset-x-auto lg:right-6 lg:bottom-24 lg:max-w-sm">
      {children}
    </output>
  );
}
