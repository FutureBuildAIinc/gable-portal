// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { acceptSupplierQuote, declineSupplierQuote } from '@core/actions/quotes';
import {
  addCatalogItem,
  addSpecialItem,
  removeItem,
  updateItemQtyDetailed,
} from '@core/actions/scope';
import { getContext } from '@core/boot';
import { isEnabled, supplierName } from '@core/config/runtime';
import { STAGE_LABELS } from '@core/domain/project';
import { hasKnownSubtotal } from '@core/domain/totals';
import { primeVolumeBreaks } from '@core/gable/pricing';
import { formatCents } from '@core/lib/money';
import { formatDate } from '@core/lib/time';
import { buildOrderDetail } from '@core/selectors/order';
import {
  catalogStore,
  ordersStore,
  projectsStore,
  quotesStore,
  scopeStore,
} from '@core/stores/root';
import { listOf } from '@core/stores/store';
import { STAGE_VAR } from '@ui/components/board/stageStyles';
import { AddItemsSheet } from '@ui/components/order/AddItemsSheet';
import { LineItemRow } from '@ui/components/order/LineItemRow';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { ChevronLeft, FileText, Lock, Plus, Store, Trash2, Truck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface Props {
  orderId: string;
  onBack: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenQuote: () => void;
  onOpenTracking: () => void;
}

export function OrderPage({ orderId, onBack, onOpenProject, onOpenQuote, onOpenTracking }: Props) {
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const scope = useStore(scopeStore, (state) => state);
  const products = useStore(catalogStore, (state) => state.products);
  const quotes = useStore(quotesStore, (state) => state);

  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** Attached to the toast when the last action is reversible. */
  const [undo, setUndo] = useState<(() => void) | null>(null);

  /**
   * Bumped once the supplier's volume-break ladders have landed.
   *
   * The pricing engine caches ladders internally and is the same object
   * before and after, so nothing else in the dependency list changes when a
   * ladder arrives. Without this the "+20 more and the price drops" prompt
   * would appear only on the next unrelated re-render.
   */
  const [breakEpoch, setBreakEpoch] = useState(0);
  /** True while an accept/decline is in flight, so the pair cannot double-fire. */
  const [deciding, setDeciding] = useState(false);

  const { clock, pricing, supplier } = getContext();

  /*
   * `breakEpoch` below is a real dependency that a syntactic check cannot see:
   * `pricing.quote` reads a volume-break cache INSIDE the engine, so the same
   * engine object answers differently once a ladder has loaded. Without it the
   * "+20 more and the price drops" prompt would wait for an unrelated
   * re-render.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: breakEpoch invalidates an internal cache
  const detail = useMemo(() => {
    const order = orders.byId[orderId];
    if (!order) return null;
    const project = projects.byId[order.projectId];
    if (!project) return null;

    return buildOrderDetail({
      order,
      project,
      items: listOf(scope).filter((item) => item.orderId === orderId),
      products,
      quoteFor: (product, qty) =>
        pricing.quote(product, qty, {
          accountId: project.accountId,
          tierId: 'tier_pro',
        }),
      now: clock.nowIso(),
    });
  }, [orderId, orders, projects, scope, products, pricing, clock, breakEpoch]);

  /**
   * Load the quantity ladders for the products actually ON this order.
   *
   * Bounded on purpose. `gable` publishes volume breaks per product
   * (`GET /catalog/{id}/volume-breaks`), not on the catalog list, so this is
   * one request per line rather than one per SKU in the dealer's catalog — and
   * the order workspace is where the "buy more, pay less" decision is actually
   * made. A no-op standalone, where the engine already holds the rules.
   */
  const lineProducts = useMemo(
    () =>
      listOf(scope)
        .filter((item) => item.orderId === orderId && item.productId)
        .map((item) => ({ id: String(item.productId), sku: item.snapshot.sku })),
    [scope, orderId],
  );

  useEffect(() => {
    if (lineProducts.length === 0) return;
    let cancelled = false;
    void primeVolumeBreaks(pricing, lineProducts).then(() => {
      if (!cancelled) setBreakEpoch((epoch) => epoch + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pricing, lineProducts]);

  function flashUndoable(message: string, action: () => void) {
    setToast(message);
    setUndo(() => action);
    setTimeout(() => {
      setToast(null);
      setUndo(null);
    }, 6000);
  }

  function flash(message: string) {
    setToast(message);
    setUndo(null);
    setTimeout(() => setToast(null), 3000);
  }

  if (!detail) {
    return (
      <div className="p-8 text-center text-sm text-text-subtle">
        That order no longer exists.{' '}
        <button type="button" onClick={onBack} className="text-brand underline">
          Back to the board
        </button>
      </div>
    );
  }

  const { order, project, lines, totals, editable, lockedReason } = detail;
  const selected = lines.find((line) => line.item.id === detailId);
  const supplierQuote = order.quoteId ? quotes.byId[order.quoteId] : undefined;
  /**
   * Whether this supplier has an accept/decline step at all.
   *
   * False on the simulator, whose desk writes prices straight onto the lines
   * and has no SENT state to answer. Hiding the buttons there is the honest
   * move: offering them and then refusing every press would teach a ceremony
   * that does not exist.
   */
  const canDecide = supplier.capabilities.quoteDecisions;

  async function handleQuoteDecision(decision: 'accept' | 'decline') {
    setDeciding(true);
    const result =
      decision === 'accept'
        ? await acceptSupplierQuote(orderId)
        : await declineSupplierQuote(orderId);
    setDeciding(false);
    // The refusal is the dealer's own sentence — `QUOTE_NOT_PRICED` carries a
    // reason a counter salesperson would say out loud, and it is shown
    // verbatim rather than flattened into "Conflict".
    flash(
      result.ok
        ? decision === 'accept'
          ? `Accepted ${result.value.number}. Move this to Order when you are ready.`
          : `Declined ${result.value.number}.`
        : result.error,
    );
  }

  /**
   * The ONE way a line leaves an order.
   *
   * There used to be two: stepping the quantity to zero, which was undoable,
   * and the detail sheet's "Remove from order" button, which was not — it just
   * flashed "Removed from order" and the line was gone for good. That is the
   * more deliberate, more prominent of the two paths, and it was the one with
   * no way back, while the comment here claimed removal is always undoable.
   */
  function removeLine(itemId: string): void {
    const doomed = detail?.lines.find((line) => line.item.id === itemId)?.item;
    const result = removeItem(itemId);
    if (!result.ok) {
      flash(result.error);
      return;
    }
    if (!doomed) {
      flash('Removed from order');
      return;
    }
    flashUndoable(`Removed ${doomed.snapshot.name}`, () => {
      const restored =
        doomed.kind === 'special'
          ? addSpecialItem({
              orderId: doomed.orderId,
              description: doomed.snapshot.name,
              qty: doomed.qty,
              ...(doomed.unitPrice !== undefined ? { estimatedUnitPrice: doomed.unitPrice } : {}),
            })
          : addCatalogItem({
              orderId: doomed.orderId,
              product: doomed.productId ?? doomed.snapshot.sku,
              qty: doomed.qty,
            });
      if (!restored.ok) flash(restored.error);
      else flash(`${doomed.snapshot.name} restored`);
    });
  }

  function handleQty(itemId: string, qty: number) {
    if (qty <= 0) {
      // Stepping to zero deletes a line. That is a reasonable gesture and an
      // unreasonable thing to do silently.
      removeLine(itemId);
      return;
    }
    const result = updateItemQtyDetailed(itemId, qty);
    if (!result.ok) {
      flash(result.error);
      return;
    }
    // Crossing a volume break silently would hide the one bit of pricing
    // mechanics this product deliberately exposes.
    const change = result.value.priceChanged;
    if (change) {
      const direction = change.to < change.from ? 'dropped' : 'rose';
      flash(`Unit price ${direction} to ${formatCents(change.to)} at this quantity`);
    }
  }

  return (
    <>
      <header className="border-b border-border bg-surface px-4 py-3 lg:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 mb-1.5 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-text-muted hover:text-text"
        >
          <ChevronLeft size={15} strokeWidth={2.5} />
          Board
        </button>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold tracking-tight">{order.name}</h2>
            <button
              type="button"
              onClick={() => onOpenProject(project.id)}
              className="truncate text-[13px] text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              {project.name}
            </button>
          </div>
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium text-on-signal"
            style={{ background: STAGE_VAR[order.stage] }}
          >
            {STAGE_LABELS[order.stage]}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            {order.fulfillment === 'delivery' ? <Truck size={13} /> : <Store size={13} />}
            {order.fulfillment === 'delivery' ? 'Delivery' : 'Will-call'}
            {order.requestedDate ? ` · ${formatDate(order.requestedDate)}` : ' · no date set'}
          </span>
          {order.poNumber ? <span className="text-data">{order.poNumber}</span> : null}
        </div>
      </header>

      {/* Money summary: their price, and what the relationship saved them. */}
      <div className="border-b border-border bg-surface-inset px-4 py-3 lg:px-6">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] text-text-muted">
            {totals.itemCount} item{totals.itemCount === 1 ? '' : 's'}
          </span>
          {/* Nothing priced yet means the total is UNKNOWN, not zero — and a
              confident $0.00 sitting above "still needs dealer pricing" is the
              one number here that could be read as a real quote. */}
          <span className="text-[19px] font-semibold tabular-nums">
            {hasKnownSubtotal(totals) ? (
              formatCents(totals.subtotal)
            ) : (
              <span className="font-normal text-text-subtle">—</span>
            )}
          </span>
        </div>
        {totals.savings > 0 ? (
          <p className="mt-0.5 text-right text-[12px] text-success">
            {formatCents(totals.savings)} below list
          </p>
        ) : null}
        {totals.awaitingQuoteCount > 0 ? (
          <p className="mt-1 text-[12px] text-warning">
            {totals.awaitingQuoteCount} item{totals.awaitingQuoteCount === 1 ? '' : 's'} still need
            {totals.awaitingQuoteCount === 1 ? 's' : ''} dealer pricing — not included above.
          </p>
        ) : null}
      </div>

      {lockedReason ? (
        <p className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5 text-[12.5px] text-text-muted lg:px-6">
          <Lock size={13} strokeWidth={2} />
          {lockedReason}
        </p>
      ) : null}

      {/* The dealer's answer to a scope this portal actually sent.
          Shown only when a supplier quote EXISTS on their side —
          `supplierRef` is the honest test for that, and a quote without one
          never left this browser. */}
      {supplierQuote?.supplierRef ? (
        <section className="border-b border-border bg-surface px-4 py-3 lg:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold">
                {supplierQuote.number} at {supplierName()}
              </p>
              <p className="mt-0.5 text-[12px] text-text-muted">
                {supplierQuote.deskNote ??
                  `${supplierName()} has this scope. They price it; nothing here is a price yet.`}
              </p>
            </div>
            {/* The dealer's own word, not the portal's rounding of it. A
                contractor phoning the yard hears the same vocabulary. */}
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
              {supplierQuote.supplierState ?? supplierQuote.status}
            </span>
          </div>

          {canDecide && supplierQuote.status === 'priced' ? (
            <div className="mt-2.5 flex gap-2">
              <Button
                size="sm"
                disabled={deciding}
                onClick={() => void handleQuoteDecision('accept')}
              >
                Accept this price
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={deciding}
                onClick={() => void handleQuoteDecision('decline')}
              >
                Decline
              </Button>
            </div>
          ) : null}

          {canDecide && supplierQuote.status === 'priced' ? (
            <p className="mt-2 text-[11.5px] text-text-subtle">
              Accepting closes the quote at {supplierName()} and puts their prices on your lines. It
              does not place the order — move the card to Order when you are ready.
            </p>
          ) : null}
        </section>
      ) : null}

      <ul className="pb-32">
        {lines.map((line) => (
          <LineItemRow
            key={line.item.id}
            line={line}
            editable={editable}
            onQtyChange={handleQty}
            onOpen={setDetailId}
          />
        ))}
        {lines.length === 0 ? (
          <li className="px-6 py-16 text-center text-sm text-text-subtle">
            Nothing on this order yet. Add materials to see your pricing.
          </li>
        ) : null}
      </ul>

      {/* Once Gable holds the order, tracking is the thing you actually want. */}
      {order.salesOrderId ? (
        <button
          type="button"
          onClick={onOpenTracking}
          className="flex w-full items-center justify-between border-border border-b bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 lg:px-6"
        >
          <span className="text-[13.5px] font-medium">Track this order</span>
          <span className="text-[12px] text-text-muted">Delivery &amp; status →</span>
        </button>
      ) : null}

      <div className="fixed inset-x-0 bottom-16 z-20 flex gap-2 border-border border-t bg-surface/95 p-3 backdrop-blur lg:bottom-0 lg:left-60">
        {editable ? (
          <Button className="flex-1" size="lg" onClick={() => setAddOpen(true)}>
            <Plus size={17} strokeWidth={2.5} />
            Add materials
          </Button>
        ) : null}
        {/* The sell side. Available even once the order is locked — a quote can
            be built from pricing that is already firm — but only on a
            deployment where the dealer offers customer quotes at all. */}
        {isEnabled('customerQuotes') ? (
          <Button
            className={cn('whitespace-nowrap', editable ? 'flex-1' : 'w-full')}
            size="lg"
            variant={editable ? 'outline' : 'primary'}
            onClick={onOpenQuote}
          >
            {/* No icon when it shares the row: two flex-1 buttons leave ~179px
                each at 390px, and icon + "Customer quote" does not fit, so the
                label wrapped to two lines and the button grew taller than the
                one beside it. The label stays whole — "Quote" alone would read
                as the board's Quote stage, which is a different thing. */}
            {editable ? null : <FileText size={17} strokeWidth={2} />}
            Customer quote
          </Button>
        ) : null}
      </div>

      <AddItemsSheet orderId={orderId} open={addOpen} onOpenChange={setAddOpen} onResult={flash} />

      <Sheet
        open={selected !== undefined}
        onOpenChange={(next) => !next && setDetailId(null)}
        title={selected?.item.snapshot.name ?? ''}
        description={selected?.item.snapshot.sku}
        footer={
          editable && selected ? (
            <Button
              variant="danger"
              full
              onClick={() => {
                removeLine(selected.item.id);
                setDetailId(null);
              }}
            >
              <Trash2 size={16} strokeWidth={2} />
              Remove from order
            </Button>
          ) : null
        }
      >
        {selected ? <ItemDetail line={selected} /> : null}
      </Sheet>

      {/* z-60: sheets sit at z-50, and feedback for an action taken INSIDE a
          sheet has to be visible above it. */}
      {toast ? (
        <output className="fixed inset-x-4 bottom-32 z-[60] flex items-center gap-3 rounded-lg bg-text px-4 py-3 text-sm text-surface shadow-[var(--shadow-lifted)] lg:inset-x-auto lg:right-6 lg:bottom-24 lg:max-w-sm">
          <span className="min-w-0 flex-1">{toast}</span>
          {undo ? (
            <button
              type="button"
              onClick={() => {
                undo();
                setUndo(null);
              }}
              className="-my-2 shrink-0 rounded-md px-2 py-2 font-semibold text-[13px] underline"
            >
              Undo
            </button>
          ) : null}
        </output>
      ) : null}
    </>
  );
}

/** PIM detail for one line: what it is, what it costs you, when you can get it. */
function ItemDetail({ line }: { line: ReturnType<typeof buildOrderDetail>['lines'][number] }) {
  const { item, product, breakOpportunity } = line;

  return (
    <div className="space-y-4">
      {item.snapshot.imageUrl ? (
        <img
          src={item.snapshot.imageUrl}
          alt=""
          className="h-40 w-full rounded-lg border border-border bg-surface-inset object-contain p-2"
        />
      ) : null}

      {product?.description ? (
        <p className="text-[13px] leading-relaxed text-text-muted">{product.description}</p>
      ) : null}

      <dl className="space-y-2 text-[13px]">
        <Row label="Your price">
          {item.unitPrice !== undefined ? (
            <span className="flex items-baseline gap-2">
              <span className="font-semibold">{formatCents(item.unitPrice)}</span>
              {item.listPrice !== undefined && item.listPrice > item.unitPrice ? (
                <span className="text-text-subtle line-through">{formatCents(item.listPrice)}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-warning">Awaiting dealer price</span>
          )}
        </Row>
        <Row label="Quantity">
          {item.qty} {item.uom}
        </Row>
        <Row label="Line total">
          {item.unitPrice !== undefined ? formatCents(line.extended) : '—'}
        </Row>
        <Row label="Availability">
          {/* Three answers, and the third one is not "In stock". An unpublished
              lead time is unknown, and rendering unknown as zero told a
              contractor the material was on the shelf. */}
          {line.leadTimeDays === undefined
            ? `${supplierName()} has not published a lead time`
            : line.leadTimeDays === 0
              ? 'In stock'
              : `${line.leadTimeDays} day lead time`}
        </Row>
      </dl>

      {breakOpportunity ? (
        <div className="rounded-lg border border-border bg-surface-inset p-3">
          <p className="text-[12.5px] leading-relaxed">
            Add <strong>{breakOpportunity.addQty} more</strong> to reach {breakOpportunity.minQty}{' '}
            {item.uom} and your unit price drops to{' '}
            <strong>{formatCents(breakOpportunity.unitPrice)}</strong>.
          </p>
        </div>
      ) : null}

      {product?.specs.length ? (
        <dl className="space-y-2 border-t border-border pt-3 text-[13px]">
          {product.specs.map((spec) => (
            <Row key={spec.label} label={spec.label}>
              {spec.value}
            </Row>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
