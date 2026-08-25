// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { PriceQuote, Product, VolumeBreak } from '../domain/catalog';
import type { PricingEngine } from '../sim/pricing';
import { priceQuoteFrom, volumeBreakFrom } from './mapper';
import type { GableCatalogProduct, GableVolumeBreak } from './schema';

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
 *  - `nextBreak` appears only for a SKU whose ladder has actually been loaded.
 *    `gable` publishes volume breaks on a SEPARATE endpoint
 *    (`GET /catalog/{id}/volume-breaks`, and on the product detail DTO), not on
 *    the catalog list, so a ladder is fetched per product rather than
 *    speculatively for the whole catalog. Until it is, `nextBreak` is absent —
 *    which is the honest state, not a claim that no break exists.
 *  - The unit price itself is NOT quantity-dependent here, because the ERP's
 *    catalog endpoint does not take a quantity. `qty` is still carried on the
 *    returned quote so the shape is identical, and `orderTotals` keeps working
 *    unchanged. The ladder says what a larger quantity WOULD cost; extending a
 *    line still uses the price the contractor is looking at.
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
  /**
   * The ladder for a SKU, or `undefined` when none has been loaded.
   *
   * `undefined` and `[]` are different answers and both are real: undefined is
   * "nobody has asked the ERP yet", `[]` is "the ERP was asked and no break
   * beats this customer's price". Only the second one justifies telling a
   * contractor there is nothing to gain by buying more.
   */
  breaksFor(sku: string): readonly VolumeBreak[] | undefined;
  /**
   * Load the ladders for these products from the ERP, once each.
   *
   * Bounded by the caller: the order workspace primes the SKUs on one order
   * and the catalog primes the product a contractor opened. Priming the whole
   * catalog would be one HTTP call per product on connect, which is a cost
   * nobody asked for to decorate rows most contractors never look at.
   *
   * A failure on one product is swallowed: a missing ladder shows no break,
   * which is the same as the unloaded state and safe. A failure must not take
   * down the price the contractor came for.
   */
  primeVolumeBreaks(products: readonly { id: string; sku: string }[]): Promise<void>;
}

/**
 * Ask whichever engine is installed to load these products' ladders.
 *
 * A no-op on the simulator, whose engine computes breaks from rules it already
 * holds and has nothing to fetch. Exported so a UI can call it without
 * branching on which supplier is connected — the same reason
 * `supplier/port.ts` exists.
 */
export function primeVolumeBreaks(
  engine: PricingEngine,
  products: readonly { id: string; sku: string }[],
): Promise<void> {
  const prime = (engine as Partial<GablePricingEngine>).primeVolumeBreaks;
  if (typeof prime !== 'function') return Promise.resolve();
  return prime(products);
}

export interface GablePricingOptions {
  /**
   * How to fetch one product's ladder. Injected rather than imported so the
   * engine stays a pure function of what it was given — and so the standalone
   * build never carries a code path that could reach the network.
   */
  loadVolumeBreaks?: (productId: string) => Promise<GableVolumeBreak[]>;
  /** Ladders already known — the product detail DTO carries its own. */
  seedBreaks?: Record<string, readonly GableVolumeBreak[]>;
}

export function createGablePricingEngine(
  dtos: readonly GableCatalogProduct[],
  options: GablePricingOptions = {},
): GablePricingEngine {
  const bySku = new Map<string, GableCatalogProduct>();
  for (const dto of dtos) bySku.set(dto.sku, dto);

  /** SKU -> ladder. A present-but-empty entry means "asked, and there are none". */
  const breaksBySku = new Map<string, VolumeBreak[]>();
  for (const [sku, seeded] of Object.entries(options.seedBreaks ?? {})) {
    breaksBySku.set(sku, seeded.map(volumeBreakFrom));
  }
  /** In-flight loads, so two components mounting at once make one request. */
  const inFlight = new Map<string, Promise<void>>();

  function quote(product: Product, qty: number): PriceQuote {
    const dto = bySku.get(product.sku);
    if (dto) return priceQuoteFrom(dto, qty, breaksBySku.get(product.sku));

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

  async function primeVolumeBreaks(
    products: readonly { id: string; sku: string }[],
  ): Promise<void> {
    const load = options.loadVolumeBreaks;
    if (!load) return;

    const pending: Promise<void>[] = [];
    for (const product of products) {
      if (!product.id || !product.sku) continue;
      if (breaksBySku.has(product.sku)) continue;

      const running = inFlight.get(product.sku);
      if (running) {
        pending.push(running);
        continue;
      }

      const task = load(product.id)
        .then((rungs) => {
          breaksBySku.set(product.sku, rungs.map(volumeBreakFrom));
        })
        .catch(() => {
          // Deliberately NOT cached as an empty ladder. Caching the failure
          // would turn "we could not ask" into "the ERP says there are none",
          // which is a claim this engine has no basis for and would never
          // retry.
        })
        .finally(() => {
          inFlight.delete(product.sku);
        });

      inFlight.set(product.sku, task);
      pending.push(task);
    }

    await Promise.all(pending);
  }

  return {
    quote,
    quoteAll: (products, qty) => products.map((product) => quote(product, qty)),
    sourceFor: (sku) => bySku.get(sku)?.price_source,
    size: () => bySku.size,
    breaksFor: (sku) => breaksBySku.get(sku),
    primeVolumeBreaks,
  };
}
