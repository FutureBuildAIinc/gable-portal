// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { PriceQuote, Product } from '../domain/catalog';
import type { PricingEngine } from '../sim/pricing';
import { priceQuoteFrom } from './mapper';
import type { GableCatalogProduct } from './schema';

/**
 * The ERP's pricing, wearing the interface the simulator's engine wears.
 *
 * `sim/pricing.ts` says it in its own header: "when a real ERP connects,
 * everything in this file is replaced by an API call that returns the same
 * `PriceQuote`. Nothing in `domain/` changes." This is that file, and the claim
 * holds — `actions/scope.ts`, `selectors/catalog.ts` and the two pages that
 * price a line all call `PricingEngine.quote` and cannot tell which side of the
 * seam answered.
 *
 * What is genuinely different, and must not be papered over:
 *
 *  - There are no tiers, no category rules and no contract table on this side.
 *    `gable` ran its own waterfall (`internal/pricing`) before it sent the
 *    number, and the portal is told the RESULT and its `price_source`. The
 *    dealer's commercial machinery stays inside the dealer's ERP, which is what
 *    `sim/pricing.ts` argued for in the first place.
 *  - `nextBreak` is always absent. `gable`'s portal catalog publishes no volume
 *    breaks, so the "buy 20 more and save" prompt goes quiet on the wired path.
 *    Absent, not zero, not invented.
 *  - Price is NOT quantity-dependent here, because the ERP's portal endpoint
 *    does not take a quantity. `qty` is still carried on the returned quote so
 *    the shape is identical, and `orderTotals` keeps working unchanged.
 *
 * The map is a snapshot of the last `GET /catalog`. That is the same freshness
 * the contractor is looking at on screen, which is the property that matters: a
 * line added from a visible price must extend to that visible price.
 */

export interface GablePricingEngine extends PricingEngine {
  /** `price_source` the ERP reported for a SKU — 'CONTRACT', 'PROMOTIONAL', … */
  sourceFor(sku: string): string | undefined;
  /** How many SKUs this engine can actually price. Read by the connection sheet. */
  size(): number;
}

export function createGablePricingEngine(dtos: readonly GableCatalogProduct[]): GablePricingEngine {
  const bySku = new Map<string, GableCatalogProduct>();
  for (const dto of dtos) bySku.set(dto.sku, dto);

  function quote(product: Product, qty: number): PriceQuote {
    const dto = bySku.get(product.sku);
    if (dto) return priceQuoteFrom(dto, qty);

    /**
     * A SKU the ERP did not price in the last catalog pull — a special-order
     * line, or a product added to the ERP since the fetch.
     *
     * It resolves to the product's own list price, unit == list, so the UI
     * shows a 0% saving rather than a discount nobody granted. Returning
     * `undefined` was the alternative and is worse: `addCatalogItem` would then
     * have to invent a price or refuse the line, and refusing a line because a
     * cache is stale is not a decision to make on a contractor's behalf.
     */
    return {
      sku: product.sku,
      unitPrice: product.listPrice,
      listPrice: product.listPrice,
      qty,
    };
  }

  return {
    quote,
    quoteAll: (products, qty) => products.map((product) => quote(product, qty)),
    sourceFor: (sku) => bySku.get(sku)?.price_source,
    size: () => bySku.size,
  };
}
