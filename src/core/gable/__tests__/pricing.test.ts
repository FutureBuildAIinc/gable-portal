// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { Product } from '../../domain/catalog';
import { productFrom } from '../mapper';
import { createGablePricingEngine } from '../pricing';
import type { GableCatalogProduct } from '../schema';

/**
 * The claim `sim/pricing.ts` has carried in a comment since M1: a real ERP
 * replaces the engine and nothing in `domain/` changes.
 *
 * These tests are that claim checked. The ERP engine satisfies the same
 * `PricingEngine` interface, returns the same `PriceQuote`, and differs only
 * where the ERP genuinely differs — no tier table on this side, and a price
 * that does not move with quantity because the catalog endpoint takes none.
 *
 * Volume breaks are NOT absent any more; they come from
 * `GET /catalog/{id}/volume-breaks` and are loaded per product. The engine
 * without a loader is the unloaded state, and the tests below assert that
 * state honestly rather than as "there are none" — the loaded behaviour is in
 * `capabilities.test.ts`.
 */

const LUMBER: GableCatalogProduct = {
  id: '161d4948-652f-4eb4-b8de-fc22d8ec57f2',
  sku: 'LUM-248-PREM',
  name: '2x4x8 SPF Premium',
  category: 'Dimensional Lumber',
  species: 'SPF',
  grade: 'Premium',
  image_url: '',
  uom: 'EA',
  base_price: 5.5,
  customer_price: 4.95,
  price_source: 'CONTRACT',
  available: 400,
  in_stock: true,
};

const product = productFrom(LUMBER);

describe('the ERP prices, the portal reports', () => {
  it('returns the customer price the ERP resolved, not a locally computed one', () => {
    const engine = createGablePricingEngine([LUMBER]);

    expect(engine.quote(product, 40, { accountId: 'a', tierId: 't' })).toEqual({
      sku: 'LUM-248-PREM',
      unitPrice: 495,
      listPrice: 550,
      qty: 40,
    });
  });

  it('ignores the tier and account the caller passes — that machinery is the ERP’s', () => {
    const engine = createGablePricingEngine([LUMBER]);

    const pro = engine.quote(product, 1, { accountId: 'acct_a', tierId: 'tier_pro' });
    const builder = engine.quote(product, 1, { accountId: 'acct_b', tierId: 'tier_builder' });

    // The dealer's commercial rules stay inside the dealer's ERP. A portal that
    // re-derived them would be publishing the dealer's margin structure.
    expect(pro).toEqual(builder);
  });

  it('does not move the price with quantity, because the endpoint takes none', () => {
    const engine = createGablePricingEngine([LUMBER]);

    expect(engine.quote(product, 1, { accountId: 'a', tierId: 't' }).unitPrice).toBe(
      engine.quote(product, 5000, { accountId: 'a', tierId: 't' }).unitPrice,
    );
  });

  it('surfaces the ERP’s own price_source so a contract price is identifiable', () => {
    const engine = createGablePricingEngine([LUMBER]);

    expect(engine.sourceFor('LUM-248-PREM')).toBe('CONTRACT');
    expect(engine.sourceFor('NOT-A-SKU')).toBeUndefined();
  });

  it('quotes a whole list in one pass, matching the sim engine’s contract', () => {
    const engine = createGablePricingEngine([LUMBER]);

    expect(engine.quoteAll([product], 2, { accountId: 'a', tierId: 't' })).toHaveLength(1);
    expect(engine.size()).toBe(1);
  });
});

describe('a SKU the ERP did not price', () => {
  const unknown: Product = { ...product, sku: 'SO-CUSTOM-DOOR', listPrice: 145_000 };

  it('falls back to list at 0% off rather than showing an ungranted discount', () => {
    const engine = createGablePricingEngine([LUMBER]);

    const quote = engine.quote(unknown, 1, { accountId: 'a', tierId: 't' });

    expect(quote.unitPrice).toBe(145_000);
    expect(quote.listPrice).toBe(145_000);
  });

  it('still returns a quote, so a stale cache cannot refuse a contractor’s line', () => {
    const engine = createGablePricingEngine([]);

    // Returning undefined would push the decision up into `addCatalogItem`,
    // which would then have to invent a price or refuse the line. Refusing a
    // line because a catalog pull is a minute old is not a decision to make on
    // a contractor's behalf.
    expect(engine.quote(product, 1, { accountId: 'a', tierId: 't' })).toBeDefined();
  });
});
