// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { PriceQuote, Product } from '../../domain/catalog';
import type { Order, Project, ScopeItem } from '../../domain/project';
import { buildOrderDetail, searchProducts } from '../order';

/**
 * `buildOrderDetail` is the read model behind the order workspace — the screen
 * a contractor is looking at when they decide to commit money. It carries a
 * per-line extension, an order total, an editability verdict, and the one piece
 * of the dealer's pricing mechanics the product deliberately surfaces: the
 * volume-break opportunity.
 *
 * Every one of those is a claim about money or about what the contractor is
 * allowed to change, which is why they are tested here rather than through a
 * component.
 */

const NOW = '2026-08-20T12:00:00.000Z';

let seq = 0;

function product(overrides: Partial<Product> = {}): Product {
  seq += 1;
  return {
    id: `p_${seq}`,
    sku: `SKU-${seq}`,
    name: `Product ${seq}`,
    description: '',
    categoryId: 'c_1',
    brandId: 'b_1',
    baseUom: 'EA',
    isActive: true,
    listPrice: 1000,
    tags: [],
    relatedSkus: [],
    specs: [],
    leadTimeDays: 0,
    stock: [],
    presentation: 'commodity',
    ...overrides,
  } as Product;
}

function item(overrides: Partial<ScopeItem> = {}): ScopeItem {
  seq += 1;
  return {
    id: `si_${seq}`,
    orderId: 'ord_1',
    kind: 'catalog',
    snapshot: { sku: `SKU-${seq}`, name: `Item ${seq}` },
    qty: 1,
    uom: 'EA',
    priceSource: 'erp',
    addedBy: 'user',
    addedAt: NOW,
    sortOrder: seq,
    ...overrides,
  } as ScopeItem;
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord_1',
    projectId: 'prj_1',
    name: 'Framing package',
    stage: 'plan',
    fulfillment: 'delivery',
    createdAt: NOW,
    updatedAt: NOW,
    sortOrder: 0,
    ...overrides,
  };
}

const PROJECT: Project = {
  id: 'prj_1',
  accountId: 'acct_summit',
  name: 'Wilson Custom Home',
  createdAt: NOW,
  updatedAt: NOW,
};

/** A quoteFor that returns whatever the test hands it, keyed by sku. */
function quoter(quotes: Record<string, Partial<PriceQuote>> = {}) {
  return (p: Product, qty: number): PriceQuote => ({
    sku: p.sku,
    unitPrice: p.listPrice,
    listPrice: p.listPrice,
    qty,
    ...quotes[p.sku],
  });
}

function build(items: ScopeItem[], opts: Partial<Parameters<typeof buildOrderDetail>[0]> = {}) {
  return buildOrderDetail({
    order: order(),
    project: PROJECT,
    items,
    products: [],
    quoteFor: quoter(),
    now: NOW,
    ...opts,
  });
}

describe('line extensions', () => {
  it('extends every line and agrees with the order total', () => {
    const detail = build([
      item({ unitPrice: 462, listPrice: 597, qty: 40, sortOrder: 1 }),
      item({ unitPrice: 1299, listPrice: 1499, qty: 3, sortOrder: 2 }),
    ]);

    expect(detail.lines.map((l) => l.extended)).toEqual([18_480, 3_897]);
    // The screen's per-line numbers must add up to the screen's total. They are
    // computed by different functions, so this is not tautological.
    expect(detail.lines.reduce((sum, l) => sum + l.extended, 0)).toBe(detail.totals.subtotal);
  });

  it('extends an unpriced line to zero without excluding it from the line list', () => {
    const detail = build([
      item({ unitPrice: 5000, qty: 1, sortOrder: 1 }),
      item({ kind: 'special', priceSource: 'unpriced', qty: 2, sortOrder: 2 }),
    ]);

    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[1]?.extended).toBe(0);
    // ...but the total knows it is incomplete.
    expect(detail.totals.unpricedCount).toBe(1);
  });

  it('uses the same expiry-aware reckoning as the board card', () => {
    // If the detail page and the card disagreed the moment a desk price lapsed,
    // the contractor would see two different numbers for one order.
    const lapsed = item({
      kind: 'special',
      priceSource: 'quoted',
      unitPrice: 45_000,
      qty: 1,
      priceExpiresAt: '2026-08-19T00:00:00.000Z',
    });

    const detail = build([lapsed]);

    expect(detail.totals.subtotal).toBe(0);
    expect(detail.totals.awaitingQuoteCount).toBe(1);
    // The LINE still shows its last known extension — that number is real
    // history, it just is not a price anyone is standing behind now.
    expect(detail.lines[0]?.extended).toBe(45_000);
  });

  it('orders lines by sortOrder, not by insertion', () => {
    const detail = build([
      item({ qty: 1, unitPrice: 100, sortOrder: 3 }),
      item({ qty: 1, unitPrice: 100, sortOrder: 1 }),
      item({ qty: 1, unitPrice: 100, sortOrder: 2 }),
    ]);

    expect(detail.lines.map((l) => l.item.sortOrder)).toEqual([1, 2, 3]);
  });
});

describe('lead times against the requested date', () => {
  it('flags a line that cannot arrive in time', () => {
    const soon = order({ requestedDate: '2026-08-25T00:00:00.000Z' }); // 4 days out
    const detail = build(
      [
        item({ unitPrice: 100, qty: 1, snapshot: { sku: 'A', name: 'A', leadTimeDays: 2 } }),
        item({ unitPrice: 100, qty: 1, snapshot: { sku: 'B', name: 'B', leadTimeDays: 10 } }),
      ],
      { order: soon },
    );

    expect(detail.lines.map((l) => l.lateForDate)).toEqual([false, true]);
  });

  it('assumes a special-order line needs three weeks when nothing says otherwise', () => {
    // A special order with no stated lead time is not an in-stock item, and
    // defaulting it to 0 would tell a contractor it can be there tomorrow.
    const detail = build([item({ kind: 'special', priceSource: 'unpriced' })]);
    expect(detail.lines[0]?.leadTimeDays).toBe(21);
  });

  it('flags nothing when no date has been requested yet', () => {
    const detail = build([
      item({ unitPrice: 100, qty: 1, snapshot: { sku: 'A', name: 'A', leadTimeDays: 90 } }),
    ]);
    expect(detail.lines[0]?.lateForDate).toBe(false);
  });
});

describe('editability', () => {
  it('is editable in Plan, and says why it is not everywhere else', () => {
    expect(build([], { order: order({ stage: 'plan' }) }).editable).toBe(true);
    expect(build([], { order: order({ stage: 'plan' }) }).lockedReason).toBeUndefined();

    for (const stage of ['quote', 'order', 'invoice'] as const) {
      const detail = build([], { order: order({ stage }) });
      expect(detail.editable, stage).toBe(false);
      // A lock with no reason is the version of this that generates support
      // calls. Every locked stage must explain itself.
      expect(detail.lockedReason, stage).toBeTruthy();
    }
  });

  it('tells the contractor how to get an order back under their control', () => {
    expect(build([], { order: order({ stage: 'quote' }) }).lockedReason).toContain('pull it back');
    expect(build([], { order: order({ stage: 'order' }) }).lockedReason).toContain('your rep');
  });
});

describe('volume break opportunities', () => {
  const SKU = 'LBR-2X4-8-DF';

  function withBreak(qty: number, unitPrice: number, minQty: number, breakPrice: number) {
    const p = product({ sku: SKU, listPrice: 597 });
    return build([item({ productId: p.id, unitPrice, qty, snapshot: { sku: SKU, name: '2x4' } })], {
      products: [p],
      quoteFor: quoter({ [SKU]: { nextBreak: { minQty, unitPrice: breakPrice } } }),
    });
  }

  it('surfaces the extra quantity needed to reach the next break', () => {
    const detail = withBreak(80, 500, 100, 428);
    expect(detail.lines[0]?.breakOpportunity?.addQty).toBe(20);
    expect(detail.lines[0]?.breakOpportunity?.minQty).toBe(100);
    expect(detail.lines[0]?.breakOpportunity?.unitPrice).toBe(428);
  });

  it('offers nothing when the line already qualifies', () => {
    // The engine only returns a nextBreak the contractor has not reached, but
    // the selector guards independently — a stale quote must not produce a
    // "buy -20 more" prompt.
    const detail = withBreak(120, 428, 100, 428);
    expect(detail.lines[0]?.breakOpportunity).toBeUndefined();
  });

  it('offers nothing on a line that has no price to improve on', () => {
    const p = product({ sku: SKU });
    const detail = build([item({ productId: p.id, priceSource: 'unpriced', qty: 10 })], {
      products: [p],
      quoteFor: quoter({ [SKU]: { nextBreak: { minQty: 100, unitPrice: 428 } } }),
    });
    expect(detail.lines[0]?.breakOpportunity).toBeUndefined();
  });

  /**
   * KNOWN DEFECT — see ROADMAP.md §6.
   *
   * `savesCents` is computed as `costNow - (breakUnitPrice * breakMinQty)`:
   * what the contractor pays for THEIR quantity, minus what they would pay for
   * the FULL break quantity. Buying up to a break normally costs more in total
   * even though the unit price falls, so a field named "saves" routinely holds
   * a negative number.
   *
   * Here: 80 @ $5.00 = $400.00 now; 100 @ $4.28 = $428.00 at the break. The
   * field reports -2800, i.e. "you save -$28.00".
   *
   * Nothing renders it today (`LineItemRow.tsx` and `OrderPage.tsx` show
   * `addQty` and `unitPrice` only), which is the only reason this has never
   * reached a contractor. It is still a public field on a money-facing
   * selector and the comment above it describes the opposite intent.
   *
   * The fix is a decision, not a typo — either rename it to a signed delta, or
   * clamp it and omit the opportunity when it is not genuinely a saving. This
   * test asserts the CORRECT behaviour so that whichever fix lands turns it
   * green rather than needing to be rewritten.
   */
  it.fails('never reports a negative saving', () => {
    const detail = withBreak(80, 500, 100, 428);
    const opportunity = detail.lines[0]?.breakOpportunity;

    expect(opportunity).toBeDefined();
    expect(opportunity?.savesCents).toBeGreaterThanOrEqual(0);
  });

  it('currently reports the negative figure — pinning the defect until it is fixed', () => {
    // Paired with the it.fails above so the exact current value is on record.
    // Delete this test in the same commit that fixes the one above.
    const detail = withBreak(80, 500, 100, 428);
    expect(detail.lines[0]?.breakOpportunity?.savesCents).toBe(400_00 - 428_00);
  });

  it('does report a real saving when the break price beats the current total outright', () => {
    // 90 @ $5.00 = $450.00; 100 @ $4.20 = $420.00. Here buying MORE genuinely
    // costs less, which is the case the comment in order.ts describes.
    const detail = withBreak(90, 500, 100, 420);
    expect(detail.lines[0]?.breakOpportunity?.savesCents).toBe(3000);
  });
});

describe('searchProducts', () => {
  const CATALOG = [
    product({ sku: 'LBR-2X4-8-DF', name: "2x4x8' Douglas Fir", tags: ['framing', 'stud'] }),
    product({ sku: 'PT-4X4-8', name: "4x4x8' Pressure Treated Post", tags: ['deck', 'post'] }),
    product({ sku: 'DECK-EVRD-16', name: 'EverDeck Decking 16ft', tags: ['deck', 'composite'] }),
  ];

  it('requires every term to match, not any', () => {
    // "deck everdeck" must not return the pressure-treated post just because it is
    // tagged deck. An add-items search that returns near-misses gets a wrong
    // SKU onto an order.
    const hits = searchProducts(CATALOG, 'deck everdeck');
    expect(hits.map((p) => p.sku)).toEqual(['DECK-EVRD-16']);
  });

  it('ranks a SKU prefix above a name or tag mention', () => {
    const hits = searchProducts(CATALOG, 'deck');
    // DECK-EVRD-16 starts with the term (score 3); PT-4X4-8 only carries the
    // tag (score 1). A contractor typing a SKU wants that SKU.
    expect(hits[0]?.sku).toBe('DECK-EVRD-16');
    expect(hits.map((p) => p.sku)).toContain('PT-4X4-8');
  });

  it('ignores single-character noise instead of matching everything', () => {
    // "a" appears in nearly every product name. Treating it as a term would
    // make the result list meaningless.
    expect(searchProducts(CATALOG, 'a').map((p) => p.sku)).toEqual(CATALOG.map((p) => p.sku));
  });

  it('returns the head of the catalog for an empty query', () => {
    expect(searchProducts(CATALOG, '   ')).toHaveLength(3);
    expect(searchProducts(CATALOG, '', 2)).toHaveLength(2);
  });

  it('honours the limit on a matching query too', () => {
    expect(searchProducts(CATALOG, 'deck', 1)).toHaveLength(1);
  });

  it('returns nothing rather than everything when no product matches', () => {
    expect(searchProducts(CATALOG, 'nonexistentwidget')).toEqual([]);
  });
});
