// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { addCatalogItem, addSpecialItem, applyTemplate } from '@core/actions/scope';
import { supplierName } from '@core/config/runtime';
import { seedTemplates } from '@core/data/template-seed';
import { isSellableQty } from '@core/domain/customer-quote';
import { formatCents } from '@core/lib/money';
import { searchProducts } from '@core/selectors/order';
import { catalogStore } from '@core/stores/root';
import { Button } from '@ui/components/ui/Button';
import { Sheet } from '@ui/components/ui/Sheet';
import { useStore } from '@ui/hooks/useStore';
import { Check, Package, PlusCircle, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Three ways onto an order, in the order a contractor reaches for them:
 * search the catalog, start from a BoM template, or describe something the
 * dealer doesn't stock.
 *
 * The special-order path matters more than it looks. Without it a contractor
 * hits a wall the moment their scope includes a custom door, and the whole job
 * leaves the portal. With it, the odd item is captured, flagged, and routed to
 * the quote desk automatically.
 */

type Mode = 'search' | 'templates' | 'special';

interface Props {
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (message: string) => void;
}

export function AddItemsSheet({ orderId, open, onOpenChange, onResult }: Props) {
  const products = useStore(catalogStore, (state) => state.products);
  const [mode, setMode] = useState<Mode>('search');
  const [query, setQuery] = useState('');

  const templates = useMemo(() => seedTemplates(), []);
  const results = useMemo(() => searchProducts(products, query, 30), [products, query]);

  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());

  /** First few product names in a template, so applying it isn't blind. */
  function previewOf(template: { items: { productId: string }[] }): string {
    const names = template.items
      .slice(0, 3)
      .map((entry) => products.find((product) => product.id === entry.productId)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? `${names.join(', ')}${template.items.length > 3 ? '…' : ''}` : '';
  }

  function handleAdd(productId: string, name: string) {
    const result = addCatalogItem({ orderId, product: productId, qty: 1 });
    onResult(result.ok ? `Added ${name}` : result.error);
    // The sheet stays open for the next item, so the row itself has to confirm.
    if (result.ok) {
      setJustAdded((current) => new Set(current).add(productId));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add to this order">
      <div className="mb-3 flex gap-1 rounded-lg bg-surface-inset p-1">
        {(
          [
            ['search', 'Search'],
            ['templates', 'Templates'],
            ['special', 'Special order'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={
              mode === id
                ? 'min-h-9 flex-1 rounded-md bg-surface text-[12.5px] font-medium shadow-[var(--shadow-card)]'
                : 'min-h-9 flex-1 rounded-md text-[12.5px] text-text-muted'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'search' ? (
        <>
          <label className="relative mb-2 block">
            <Search
              size={15}
              className="-translate-y-1/2 absolute top-1/2 left-3 text-text-subtle"
              strokeWidth={2}
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products or paste a SKU"
              className="min-h-11 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand"
            />
          </label>

          <ul className="divide-y divide-border">
            {results.map((product) => {
              const added = justAdded.has(product.id);
              return (
                <li key={product.id} className="flex items-center gap-3 py-2">
                  {/* A photo identifies a 2x6 faster than its SKU does. */}
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg border border-border bg-white object-cover"
                    />
                  ) : (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
                      <Package size={18} strokeWidth={1.5} className="text-text-subtle" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{product.name}</p>
                    <p className="text-data text-text-subtle">{product.sku}</p>
                  </div>
                  <span className="shrink-0 text-right">
                    <span className="block text-[13px] font-medium tabular-nums">
                      {formatCents(product.listPrice)}
                    </span>
                    {/* Say it's list, or it reads as the contractor's price. */}
                    <span className="block text-[10.5px] text-text-subtle">list</span>
                  </span>
                  <Button
                    variant={added ? 'outline' : 'secondary'}
                    aria-label={`Add ${product.name}`}
                    onClick={() => handleAdd(product.id, product.name)}
                  >
                    {added ? (
                      <>
                        <Check size={15} strokeWidth={2.5} style={{ color: 'var(--success)' }} />
                        Added
                      </>
                    ) : (
                      'Add'
                    )}
                  </Button>
                </li>
              );
            })}
            {results.length === 0 ? (
              <li className="py-8 text-center text-sm text-text-subtle">
                Nothing matched. Try the Special order tab for items {supplierName()} doesn't stock.
              </li>
            ) : null}
          </ul>
        </>
      ) : null}

      {mode === 'templates' ? (
        <ul className="space-y-2">
          {templates.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                onClick={() => {
                  const result = applyTemplate(orderId, template);
                  const merged =
                    result.ok && result.value.merged > 0
                      ? `, merged ${result.value.merged} you already had`
                      : '';
                  onResult(
                    result.ok
                      ? `Added ${result.value.added} items from ${template.name}${merged}`
                      : result.error,
                  );
                  onOpenChange(false);
                }}
                className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-surface-2"
              >
                <Package size={17} className="mt-0.5 shrink-0 text-brand" strokeWidth={2} />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">{template.name}</span>
                  <span className="mt-0.5 block text-[12px] text-text-muted">
                    {template.items.length} items
                  </span>
                  {/* What's actually in it — "8 items" commits blind. */}
                  <span className="mt-0.5 block truncate text-[11.5px] text-text-subtle">
                    {previewOf(template)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {mode === 'special' ? (
        <SpecialOrderForm
          orderId={orderId}
          onDone={(message) => {
            onResult(message);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Sheet>
  );
}

function SpecialOrderForm({
  orderId,
  onDone,
}: {
  orderId: string;
  onDone: (message: string) => void;
}) {
  const [description, setDescription] = useState('');
  const [qty, setQty] = useState('1');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // `Number(qty) || 1` used to sit here, and it read as a guard while
        // being the opposite of one: it only rescued NaN and the empty string,
        // so "-3" was truthy and went straight through to the order — and out
        // the far side into `lineExtended`, where a negative quantity is a
        // negative extended price and the quote prices against the yard.
        const wanted = Number(qty.trim());
        if (!isSellableQty(wanted)) {
          onDone('Enter a quantity of 1 or more before adding this item.');
          return;
        }
        const result = addSpecialItem({
          orderId,
          description,
          qty: wanted,
        });
        onDone(result.ok ? `Added "${description}" for dealer pricing` : result.error);
      }}
      className="space-y-3"
    >
      <p className="rounded-lg bg-surface-inset p-3 text-[12.5px] leading-relaxed text-text-muted">
        For anything {supplierName()} doesn't stock. It goes on the order unpriced and the quote
        desk comes back with a firm number.
      </p>

      <label className="block">
        <span className="mb-1 block text-[12px] font-medium">Describe the item</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          placeholder="Custom mahogany entry door, 36x80, pre-hung, left swing"
          className="w-full rounded-lg border border-border bg-surface p-3 text-sm outline-none focus:border-brand"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[12px] font-medium">Quantity</span>
        <input
          value={qty}
          onChange={(event) => setQty(event.target.value)}
          type="number"
          inputMode="numeric"
          // The browser's own floor, so a phone keypad offers no minus sign and
          // the spinner will not walk below one. It is the courtesy, not the
          // control — `min` is trivially bypassed and the submit above is what
          // actually refuses.
          min={1}
          className="min-h-11 w-28 rounded-lg border border-border bg-surface px-3 text-sm outline-none focus:border-brand"
        />
      </label>

      <Button type="submit" full disabled={description.trim().length === 0}>
        <PlusCircle size={16} strokeWidth={2} />
        Add for dealer pricing
      </Button>
    </form>
  );
}
