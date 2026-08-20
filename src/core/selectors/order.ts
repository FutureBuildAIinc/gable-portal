// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { PriceQuote, Product, VolumeBreak } from '../domain/catalog';
import type { Order, Project, ScopeItem } from '../domain/project';
import { itemExtended } from '../domain/project';
import { type OrderTotals, orderTotals } from '../domain/totals';
import { type Cents, multiplyCents } from '../lib/money';
import { daysBetween } from '../lib/time';

/**
 * Read model for one order's scope.
 *
 * The volume-break opportunity is computed here rather than in the component
 * because it is the single piece of pricing mechanics the product surfaces:
 * a contractor who can't see "20 more units drops your unit price" is leaving
 * money on the table, and that is exactly the value a dealer portal should be
 * adding over a retail site.
 */

export interface ScopeLine {
  item: ScopeItem;
  product?: Product;
  extended: Cents;
  /** True when this line alone cannot arrive by the order's requested date. */
  lateForDate: boolean;
  leadTimeDays: number;
  /** Present when buying more would lower the unit price. */
  breakOpportunity?: BreakOpportunity;
}

export interface BreakOpportunity extends VolumeBreak {
  /** How many more units are needed to qualify. */
  addQty: number;
  /**
   * What buying up to the break saves on this line overall — 0 unless the
   * break quantity at the break price genuinely costs LESS than the current
   * quantity at the current price. Never negative.
   */
  savesCents: Cents;
  /**
   * What buying up to the break costs on this line overall — 0 when it is a
   * saving. Never negative. This is the ordinary case: the unit price drops
   * and the total still goes up.
   */
  addCostCents: Cents;
}

export interface OrderDetail {
  order: Order;
  project: Project;
  lines: ScopeLine[];
  totals: OrderTotals;
  editable: boolean;
  /** Why editing is locked, if it is. */
  lockedReason?: string;
}

function lockReason(order: Order): string | undefined {
  switch (order.stage) {
    case 'quote':
      return 'With the quote desk — pull it back to Plan to change the scope.';
    case 'order':
      return 'Order placed. Contact your rep to change it.';
    case 'invoice':
      return 'Delivered and invoiced.';
    default:
      return undefined;
  }
}

function breakOpportunityFor(
  item: ScopeItem,
  quote: PriceQuote | undefined,
): BreakOpportunity | undefined {
  const next = quote?.nextBreak;
  if (!next || item.unitPrice === undefined) return undefined;

  const addQty = next.minQty - item.qty;
  if (addQty <= 0) return undefined;

  // Compare like for like: what the contractor pays now for their quantity,
  // against what they'd pay for the FULL break quantity at the break price.
  // If buying more actually costs less overall, that is worth saying out loud.
  const costNow = multiplyCents(item.unitPrice, item.qty);
  const costAtBreak = multiplyCents(next.unitPrice, next.minQty);
  const delta = costNow - costAtBreak;

  // Two halves of the same trade, each under its own name. Buying up to a
  // break lowers the UNIT price, so it usually raises the TOTAL — reporting
  // that as a negative "saving" is how a screen ends up telling a contractor
  // they save -$28.00. So `savesCents` only ever holds a real saving (the
  // break quantity beating the current total outright), and the ordinary
  // case — pay more, get a better rate — is carried by `addCostCents`.
  // Exactly one of the two is non-zero. `orderTotals.savings` clamps the same
  // way for the same reason.
  return {
    ...next,
    addQty,
    savesCents: Math.max(0, delta),
    addCostCents: Math.max(0, -delta),
  };
}

export interface BuildOrderDetailInput {
  order: Order;
  project: Project;
  items: readonly ScopeItem[];
  products: readonly Product[];
  quoteFor: (product: Product, qty: number) => PriceQuote;
  now: string;
}

export function buildOrderDetail(input: BuildOrderDetailInput): OrderDetail {
  const productById = new Map(input.products.map((product) => [product.id, product]));
  const daysToDate = input.order.requestedDate
    ? daysBetween(input.now, input.order.requestedDate)
    : null;

  const lines: ScopeLine[] = [...input.items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => {
      const product = item.productId ? productById.get(item.productId) : undefined;
      const leadTimeDays = item.snapshot.leadTimeDays ?? (item.kind === 'special' ? 21 : 0);
      const quote = product ? input.quoteFor(product, item.qty) : undefined;

      const opportunity = breakOpportunityFor(item, quote);

      return {
        item,
        ...(product ? { product } : {}),
        extended: itemExtended(item),
        lateForDate: daysToDate !== null && daysToDate >= 0 && leadTimeDays > daysToDate,
        leadTimeDays,
        ...(opportunity ? { breakOpportunity: opportunity } : {}),
      };
    });

  const locked = lockReason(input.order);

  return {
    order: input.order,
    project: input.project,
    lines,
    // Same expiry-aware reckoning as the board card, or the two disagree
    // about the same order the moment a desk price lapses.
    totals: orderTotals(input.items, input.now),
    editable: locked === undefined,
    ...(locked ? { lockedReason: locked } : {}),
  };
}

/** Simple keyword search over the catalog, for the add-items flow. */
export function searchProducts(products: readonly Product[], query: string, limit = 25): Product[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return products.slice(0, limit);

  const scored: { product: Product; score: number }[] = [];
  for (const product of products) {
    const haystack = `${product.sku} ${product.name} ${product.tags.join(' ')}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        score = -1;
        break;
      }
      // Exact SKU prefix beats a name mention — a contractor typing a SKU
      // wants that SKU.
      score += product.sku.toLowerCase().startsWith(term) ? 3 : 1;
    }
    if (score > 0) scored.push({ product, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.product);
}
