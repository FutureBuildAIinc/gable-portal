// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { addCatalogItem } from '@core/actions/scope';
import { getContext } from '@core/boot';
import { supplierName } from '@core/config/runtime';
import { discountPercent, savingsPerUnit } from '@core/domain/catalog';
import type { Order } from '@core/domain/project';
import { formatCents } from '@core/lib/money';
import { type CatalogRow, browseCatalog, catalogTree } from '@core/selectors/catalog';
import { catalogStore, ordersStore, projectsStore, sessionStore } from '@core/stores/root';
import { listOf } from '@core/stores/store';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { cn } from '@ui/lib/cn';
import { ChevronLeft, ChevronRight, Clock, Package, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Catalog as a destination, not a picker.
 *
 * The add-items sheet answers "get this SKU onto the order I already have
 * open". This answers a different question — "what does the yard carry, and
 * what does it cost ME" — which is why every row leads with the contractor's
 * price and not list. A catalog that showed list would be a price book, and a
 * contractor already has one of those.
 *
 * Adding from here needs an order to add TO, so the flow ends in a picker
 * rather than pretending there is a cart. There is no cart in this product by
 * design: materials belong to a job.
 */

interface Props {
  onOpenOrder: (orderId: string) => void;
}

export function CatalogPage({ onOpenOrder }: Props) {
  const catalog = useStore(catalogStore, (state) => state);
  const orders = useStore(ordersStore, (state) => state);
  const projects = useStore(projectsStore, (state) => state);
  const account = useStore(sessionStore, (state) => state.account);

  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogRow | null>(null);
  const [pickingFor, setPickingFor] = useState<CatalogRow | null>(null);
  const [toast, setToast] = useState<{ message: string; orderId?: string } | null>(null);

  const { pricing } = getContext();

  /**
   * Empty aisles are not offered.
   *
   * The salvaged catalog carries categories the dealer does not stock —
   * "Appliances 0" sat in the chip row and led to a blank list. A category
   * with nothing in it is a dead end that costs a tap to discover, and it
   * makes the whole tree look unreliable.
   */
  const tree = useMemo(
    () => catalogTree(catalog.categories, catalog.products).filter((branch) => branch.count > 0),
    [catalog.categories, catalog.products],
  );

  const rows = useMemo(
    () =>
      browseCatalog({
        products: catalog.products,
        categories: catalog.categories,
        query,
        categoryId: categoryId ?? undefined,
        // Priced at a quantity of one: this is a shelf price, and quoting a
        // volume break the contractor has not asked for would be a number they
        // cannot actually get.
        quoteFor: (product) =>
          account
            ? pricing.quote(product, 1, { accountId: account.id, tierId: 'tier_pro' })
            : undefined,
      }),
    [catalog.products, catalog.categories, query, categoryId, pricing, account],
  );

  const activeCategory = categoryId
    ? catalog.categories.find((category) => category.id === categoryId)
    : undefined;

  function flash(message: string, orderId?: string) {
    setToast(orderId ? { message, orderId } : { message });
    setTimeout(() => setToast(null), 4200);
  }

  function addTo(orderId: string, row: CatalogRow) {
    const result = addCatalogItem({ orderId, product: row.product.id, qty: 1 });
    setPickingFor(null);
    setDetail(null);
    if (!result.ok) {
      // The refusal is contractor-facing copy — including "only an owner can",
      // which is the whole point of showing it rather than a generic error.
      flash(result.error);
      return;
    }
    const order = orders.byId[orderId];
    flash(`Added to ${order?.name ?? 'the order'}`, orderId);
  }

  return (
    <div className="pb-24">
      {/* Search first: a contractor with a SKU in hand should never have to
          find the right aisle before they can type it. */}
      <div className="sticky top-0 z-10 border-border border-b bg-surface/95 px-4 py-3 backdrop-blur lg:px-6">
        <div className="relative">
          <Search
            size={16}
            strokeWidth={2}
            className="-translate-y-1/2 absolute top-1/2 left-3 text-text-subtle"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${supplierName()}'s catalog`}
            aria-label="Search the catalog"
            className="min-h-11 w-full rounded-lg border border-border bg-surface pr-9 pl-9 text-sm outline-none focus:border-brand"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="-translate-y-1/2 absolute top-1/2 right-2 flex h-8 w-8 items-center justify-center rounded-md text-text-subtle hover:text-text"
            >
              <X size={15} strokeWidth={2} />
            </button>
          ) : null}
        </div>

        {/* Categories are hidden while searching: search spans the whole
            catalog, so leaving an aisle highlighted would imply it narrowed
            the results when it did not. */}
        {query ? null : (
          <div className="-mx-4 mt-2.5 flex gap-2 overflow-x-auto px-4 pb-0.5 lg:-mx-6 lg:px-6">
            <Chip active={categoryId === null} onClick={() => setCategoryId(null)}>
              All {catalog.products.length}
            </Chip>
            {tree.map((branch) => (
              <Chip
                key={branch.category.id}
                active={categoryId === branch.category.id}
                onClick={() => setCategoryId(branch.category.id)}
              >
                {branch.category.name} {branch.count}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {activeCategory ? (
        <button
          type="button"
          onClick={() => setCategoryId(null)}
          className="flex min-h-10 items-center gap-1 px-4 pt-3 text-[12.5px] text-text-muted hover:text-text lg:px-6"
        >
          <ChevronLeft size={14} strokeWidth={2.5} />
          All categories
        </button>
      ) : null}

      <p className="px-4 pt-3 pb-1 text-[12px] text-text-subtle lg:px-6">
        {rows.length} {rows.length === 1 ? 'product' : 'products'}
        {activeCategory ? ` in ${activeCategory.name}` : ''} · your account pricing
      </p>

      <ul className="divide-y divide-border border-border border-t">
        {rows.map((row) => (
          <li key={row.product.id}>
            <button
              type="button"
              onClick={() => setDetail(row)}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 lg:px-6"
            >
              <Thumb row={row} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[13.5px]">{row.product.name}</span>
                <span className="text-data block text-text-subtle">{row.product.sku}</span>
                <StockLine row={row} />
              </span>
              <PriceCell row={row} />
            </button>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-6 py-16 text-center text-sm text-text-subtle">
            Nothing matches "{query}". {supplierName()} may still be able to special-order it — add
            it from inside an order.
          </li>
        ) : null}
      </ul>

      {/* One sheet at a time. Opening the picker on top of the product sheet
          left two overlays stacked, and the upper one swallowed every tap —
          the picker was on screen and completely unusable. */}
      <ProductSheet
        row={detail}
        onClose={() => setDetail(null)}
        onAdd={() => {
          setPickingFor(detail);
          setDetail(null);
        }}
      />

      <OrderPicker
        row={pickingFor}
        orders={listOf(orders)}
        projectName={(projectId) => projects.byId[projectId]?.name ?? 'Project'}
        onClose={() => setPickingFor(null)}
        onPick={addTo}
      />

      {/* z-60 so feedback for an action taken INSIDE a sheet clears the sheet.
          The order name is not much use without a way to get there, so the
          confirmation carries the jump rather than describing it. */}
      {toast ? (
        <div className="fixed inset-x-4 bottom-20 z-60 flex items-center gap-3 rounded-lg bg-text px-4 py-3 text-[13px] text-surface shadow-[var(--shadow-lifted)] lg:left-auto lg:w-96">
          <span className="min-w-0 flex-1">{toast.message}</span>
          {toast.orderId ? (
            <button
              type="button"
              onClick={() => {
                const id = toast.orderId;
                setToast(null);
                if (id) onOpenOrder(id);
              }}
              className="shrink-0 font-semibold underline underline-offset-2"
            >
              Open
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-h-9 shrink-0 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        active
          ? 'border-brand bg-brand-tint text-brand'
          : 'border-border text-text-muted hover:bg-surface-2 hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function Thumb({ row, size = 44 }: { row: CatalogRow; size?: number }) {
  const url = row.product.imageUrl;
  if (!url) {
    return (
      <span
        className="flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2"
        style={{ width: size, height: size }}
      >
        <Package size={size / 2.5} strokeWidth={1.5} className="text-text-subtle" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="shrink-0 rounded-lg border border-border bg-white object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Stock and lead time, stated as a consequence rather than a number.
 *
 * "23d lead" is arithmetic homework; "special order — 23 days" is the fact a
 * contractor plans around.
 */
function StockLine({ row }: { row: CatalogRow }) {
  if (row.stocked) {
    return (
      <span className="block text-[11.5px] text-success">In stock · {row.onHand} on hand</span>
    );
  }
  // Nothing on hand and no published lead time. "Special order — 0 days" is
  // what this used to say, which reads as "here tomorrow" for an item the
  // dealer has never put a date on. Say the true thing and let the contractor
  // ask.
  if (row.leadTimeDays === undefined) {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-warning">
        <Clock size={11} strokeWidth={2.5} />
        Special order — {supplierName()} has not published a lead time
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-warning">
      <Clock size={11} strokeWidth={2.5} />
      {row.leadTimeDays === 0
        ? 'Special order — ships same day'
        : `Special order — ${row.leadTimeDays} days`}
    </span>
  );
}

function PriceCell({ row }: { row: CatalogRow }) {
  const quote = row.quote;
  if (!quote) {
    // Never a confident wrong number: no resolved price means unknown, and
    // "$0.00" here would read as free.
    return <span className="shrink-0 text-[13px] text-text-subtle">—</span>;
  }
  const saved = savingsPerUnit(quote);
  return (
    <span className="shrink-0 text-right">
      <span className="block font-semibold text-[14px] tabular-nums">
        {formatCents(quote.unitPrice)}
      </span>
      <span className="block text-[10.5px] text-text-subtle">/{row.product.baseUom}</span>
      {/* List is struck through in subtle grey, matching the order screen.
          It was green — the success colour — on the HIGHER number, which reads
          as "this is what you saved" when it is the opposite. Colour has to
          encode state, and the state here is "superseded". */}
      {saved > 0 ? (
        <span className="block text-[10.5px] text-text-subtle line-through">
          {formatCents(row.product.listPrice)}
        </span>
      ) : null}
    </span>
  );
}

function ProductSheet({
  row,
  onClose,
  onAdd,
}: {
  row: CatalogRow | null;
  onClose: () => void;
  onAdd: () => void;
}) {
  return (
    <Sheet
      open={row !== null}
      onOpenChange={(next) => !next && onClose()}
      title={row?.product.name ?? ''}
      description={row?.product.sku}
      footer={
        row ? (
          <Button full size="lg" onClick={onAdd}>
            Add to an order
          </Button>
        ) : null
      }
    >
      {row ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <Thumb row={row} size={88} />
            <div className="min-w-0 flex-1">
              {row.quote ? (
                <>
                  <p className="font-semibold text-[22px] leading-none tabular-nums">
                    {formatCents(row.quote.unitPrice)}
                    <span className="ml-1 font-normal text-[12px] text-text-muted">
                      /{row.product.baseUom}
                    </span>
                  </p>
                  {savingsPerUnit(row.quote) > 0 ? (
                    <p className="mt-1 text-[12.5px] text-success">
                      {discountPercent(row.quote)}% under the {formatCents(row.product.listPrice)}{' '}
                      list price
                    </p>
                  ) : (
                    <p className="mt-1 text-[12.5px] text-text-muted">This is the list price.</p>
                  )}
                </>
              ) : (
                <p className="text-[13px] text-text-muted">
                  {supplierName()} will price this for you.
                </p>
              )}
              <div className="mt-2">
                <StockLine row={row} />
              </div>
            </div>
          </div>

          <p className="text-[13px] leading-relaxed text-text-muted">{row.product.description}</p>

          {/* The next volume break is the one piece of pricing mechanics this
              product deliberately exposes — hiding it here would make the
              catalog less useful than the order screen. */}
          {row.quote?.nextBreak ? (
            <p className="rounded-lg bg-surface-inset p-3 text-[12.5px] text-text-muted">
              Buy {row.quote.nextBreak.minQty} or more and this drops to{' '}
              <strong className="text-text">
                {formatCents(row.quote.nextBreak.unitPrice)}/{row.product.baseUom}
              </strong>
              .
            </p>
          ) : null}

          {row.product.specs.length > 0 ? (
            <dl className="divide-y divide-border rounded-lg border border-border">
              {row.product.specs.map((spec) => (
                <div
                  key={spec.label}
                  className="flex justify-between gap-4 px-3 py-2 text-[12.5px]"
                >
                  <dt className="text-text-muted">{spec.label}</dt>
                  <dd className="text-right">{spec.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Which job is this for?
 *
 * There is no cart in this product: materials belong to an order, and an order
 * belongs to a job. Only Plan-stage orders are offered because scope locks
 * once the supplier holds it — offering a locked order and then refusing the
 * add would teach the rule the hard way.
 */
function OrderPicker({
  row,
  orders,
  projectName,
  onClose,
  onPick,
}: {
  row: CatalogRow | null;
  orders: readonly Order[];
  projectName: (projectId: string) => string;
  onClose: () => void;
  onPick: (orderId: string, row: CatalogRow) => void;
}) {
  const open = row !== null;
  const draftable = orders
    .filter((order) => order.stage === 'plan')
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Add to which order?"
      description={row?.product.name}
    >
      {draftable.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-text-subtle">
          Every order is already with {supplierName()}. Start a new one from the board, or pull one
          back to Plan to keep editing it.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {draftable.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => row && onPick(order.id, row)}
                className="flex min-h-14 w-full items-center gap-3 px-1 text-left transition-colors hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[13.5px]">{order.name}</span>
                  <span className="block truncate text-[12px] text-text-muted">
                    {projectName(order.projectId)}
                  </span>
                </span>
                {/* A chevron, not a check. A tick means "done" — on a row you
                    have not chosen yet it reads as already-added. */}
                <ChevronRight size={16} strokeWidth={2.5} className="shrink-0 text-text-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {draftable.length > 0 && row ? (
        <p className="mt-3 text-[11.5px] text-text-subtle">
          Adds one {row.product.baseUom}. Change the quantity on the order.
        </p>
      ) : null}
    </Sheet>
  );
}
