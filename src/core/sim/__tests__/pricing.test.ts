// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { Product } from '../../domain/catalog';
import { discountPercent } from '../../domain/catalog';
import { toCents } from '../../lib/money';
import { type PricingRule, type PricingTier, createPricingEngine } from '../pricing';

const TIERS: PricingTier[] = [
  { id: 'tier_standard', name: 'Standard', percentOffList: 0 },
  { id: 'tier_pro', name: 'Pro', percentOffList: 12 },
];

const ACCOUNT = { accountId: 'acct_1', tierId: 'tier_pro' };
const OTHER_ACCOUNT = { accountId: 'acct_2', tierId: 'tier_pro' };
const STANDARD_ACCOUNT = { accountId: 'acct_3', tierId: 'tier_standard' };

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p_1',
    sku: 'LBR-2X4-8-DF',
    name: "2x4x8' Douglas Fir",
    description: '',
    categoryId: 'c_1',
    brandId: 'b_1',
    baseUom: 'EA',
    isActive: true,
    listPrice: toCents(10),
    tags: [],
    relatedSkus: [],
    specs: [],
    leadTimeDays: 0,
    stock: [],
    presentation: 'commodity' as const,
    ...overrides,
  };
}

describe('ERP pricing precedence', () => {
  it('falls back to list when the account has no tier discount', () => {
    const engine = createPricingEngine(TIERS, []);
    const quote = engine.quote(product(), 1, STANDARD_ACCOUNT);

    expect(quote.unitPrice).toBe(toCents(10));
    expect(discountPercent(quote)).toBe(0);
  });

  it('applies the tier baseline', () => {
    const engine = createPricingEngine(TIERS, []);
    const quote = engine.quote(product(), 1, ACCOUNT);

    expect(quote.unitPrice).toBe(toCents(8.8)); // 12% off
    expect(quote.listPrice).toBe(toCents(10));
  });

  it('lets a category rule beat the tier baseline', () => {
    const rules: PricingRule[] = [
      { kind: 'category', tierId: 'tier_pro', categoryId: 'c_1', percentOffList: 18 },
    ];
    const engine = createPricingEngine(TIERS, rules);

    expect(engine.quote(product(), 1, ACCOUNT).unitPrice).toBe(toCents(8.2));
  });

  it('lets an account-specific rule beat a tier rule', () => {
    const rules: PricingRule[] = [
      { kind: 'category', tierId: 'tier_pro', categoryId: 'c_1', percentOffList: 15 },
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_1', percentOffList: 22 },
    ];
    const engine = createPricingEngine(TIERS, rules);

    expect(engine.quote(product(), 1, ACCOUNT).unitPrice).toBe(toCents(7.8));
    // The other account only gets the tier rule.
    expect(engine.quote(product(), 1, OTHER_ACCOUNT).unitPrice).toBe(toCents(8.5));
  });

  it('gives a contract price the final word', () => {
    const rules: PricingRule[] = [
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_1', percentOffList: 22 },
      { kind: 'contract', accountId: 'acct_1', sku: 'LBR-2X4-8-DF', unitPrice: toCents(4.62) },
    ];
    const engine = createPricingEngine(TIERS, rules);

    expect(engine.quote(product(), 1, ACCOUNT).unitPrice).toBe(toCents(4.62));
    // Contract prices are per-account, not global.
    expect(engine.quote(product(), 1, OTHER_ACCOUNT).unitPrice).toBe(toCents(8.8));
  });

  it('does not leak a rule across categories', () => {
    const rules: PricingRule[] = [
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_99', percentOffList: 40 },
    ];
    const engine = createPricingEngine(TIERS, rules);

    expect(engine.quote(product(), 1, ACCOUNT).unitPrice).toBe(toCents(8.8));
  });
});

describe('category rules cascade down the tree', () => {
  // c_lumber > c_framing > c_studs
  const PARENTS = new Map<string, string | undefined>([
    ['c_lumber', undefined],
    ['c_framing', 'c_lumber'],
    ['c_studs', 'c_framing'],
  ]);
  const stud = product({ categoryId: 'c_studs' });

  it('applies a parent-category rule to a product in a subcategory', () => {
    // "18% off Lumber" must reach a stud sitting two levels down. Without the
    // cascade this silently fell back to the 12% tier baseline.
    const rules: PricingRule[] = [
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_lumber', percentOffList: 18 },
    ];
    const engine = createPricingEngine(TIERS, rules, PARENTS);

    expect(engine.quote(stud, 1, ACCOUNT).unitPrice).toBe(toCents(8.2));
  });

  it('lets the nearest category level win', () => {
    const rules: PricingRule[] = [
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_lumber', percentOffList: 30 },
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_framing', percentOffList: 20 },
    ];
    const engine = createPricingEngine(TIERS, rules, PARENTS);

    // Framing is nearer than Lumber, so 20% applies even though 30% is bigger:
    // the dealer set a deliberate exception on the narrower category.
    expect(engine.quote(stud, 1, ACCOUNT).unitPrice).toBe(toCents(8));
  });

  it('keeps an account rule ahead of a nearer tier rule', () => {
    const rules: PricingRule[] = [
      { kind: 'category', accountId: 'acct_1', categoryId: 'c_lumber', percentOffList: 25 },
      { kind: 'category', tierId: 'tier_pro', categoryId: 'c_studs', percentOffList: 15 },
    ];
    const engine = createPricingEngine(TIERS, rules, PARENTS);

    expect(engine.quote(stud, 1, ACCOUNT).unitPrice).toBe(toCents(7.5));
  });

  it('cascades volume breaks too', () => {
    const rules: PricingRule[] = [
      { kind: 'volume', categoryId: 'c_lumber', breaks: [{ minQty: 100, extraPercentOff: 10 }] },
    ];
    const engine = createPricingEngine(TIERS, rules, PARENTS);

    // 12% tier, then 10% more at volume.
    expect(engine.quote(stud, 100, ACCOUNT).unitPrice).toBe(toCents(7.92));
  });

  it('survives a cycle in malformed category data', () => {
    const cyclic = new Map<string, string | undefined>([
      ['c_a', 'c_b'],
      ['c_b', 'c_a'],
    ]);
    const engine = createPricingEngine(TIERS, [], cyclic);

    expect(() => engine.quote(product({ categoryId: 'c_a' }), 1, ACCOUNT)).not.toThrow();
  });
});

describe('volume breaks', () => {
  // Base for the Pro tier is $8.80 (12% off a $10 list). 10% extra off => $7.92,
  // 20% extra off => $7.04.
  const rules: PricingRule[] = [
    {
      kind: 'volume',
      categoryId: 'c_1',
      breaks: [
        { minQty: 100, extraPercentOff: 10 },
        { minQty: 500, extraPercentOff: 20 },
      ],
    },
  ];
  const engine = createPricingEngine(TIERS, rules);

  it('charges the normal price below the first break', () => {
    const quote = engine.quote(product(), 10, ACCOUNT);
    expect(quote.unitPrice).toBe(toCents(8.8));
  });

  it('applies a break once the quantity qualifies', () => {
    expect(engine.quote(product(), 100, ACCOUNT).unitPrice).toBe(toCents(7.92));
    expect(engine.quote(product(), 500, ACCOUNT).unitPrice).toBe(toCents(7.04));
  });

  it('surfaces the next break so the contractor can see the upside', () => {
    const quote = engine.quote(product(), 80, ACCOUNT);
    expect(quote.nextBreak).toEqual({ minQty: 100, unitPrice: toCents(7.92) });
  });

  it('scales a category break to each product, never a flat price', () => {
    // The bug this guards: an absolute category-wide break price told a
    // contractor that 100 of a $30 post would cost $4.28 each.
    const cheap = product({ sku: 'CHEAP', listPrice: toCents(10) });
    const pricey = product({ sku: 'PRICEY', listPrice: toCents(30) });

    const cheapQuote = engine.quote(cheap, 100, ACCOUNT);
    const priceyQuote = engine.quote(pricey, 100, ACCOUNT);

    expect(cheapQuote.unitPrice).toBe(toCents(7.92));
    expect(priceyQuote.unitPrice).toBe(toCents(23.76));
    // The expensive product must never be dragged down to the cheap one's price.
    expect(priceyQuote.unitPrice).toBeGreaterThan(cheapQuote.unitPrice);
  });

  it('ignores an absolute break attached to a category, since it cannot be trusted', () => {
    const bogus = createPricingEngine(TIERS, [
      { kind: 'volume', categoryId: 'c_1', breaks: [{ minQty: 10, unitPrice: toCents(1) }] },
    ]);
    // Falls back to the tier price rather than quoting an absurd $1.
    expect(bogus.quote(product(), 100, ACCOUNT).unitPrice).toBe(toCents(8.8));
  });

  it('honours an absolute break when the rule names a sku', () => {
    const skuScoped = createPricingEngine(TIERS, [
      { kind: 'volume', sku: 'LBR-2X4-8-DF', breaks: [{ minQty: 250, unitPrice: toCents(3.98) }] },
    ]);
    expect(skuScoped.quote(product(), 250, ACCOUNT).unitPrice).toBe(toCents(3.98));
  });

  it('does not stack a category volume discount on a negotiated contract price', () => {
    // A contract price is locked by definition. Letting a category-wide break
    // cut it further would double-dip the dealer on a number they already
    // negotiated down.
    const withContract = createPricingEngine(TIERS, [
      ...rules,
      { kind: 'contract', accountId: 'acct_1', sku: 'LBR-2X4-8-DF', unitPrice: toCents(4.62) },
    ]);
    const quote = withContract.quote(product(), 500, ACCOUNT);

    expect(quote.unitPrice).toBe(toCents(4.62));
    expect(quote.nextBreak).toBeUndefined();
  });

  it('still honours a volume tier written for the contracted sku itself', () => {
    // The dealer deliberately set a volume tier on this exact item, so it
    // applies even though a contract price exists.
    const engineWithSkuTier = createPricingEngine(TIERS, [
      { kind: 'contract', accountId: 'acct_1', sku: 'LBR-2X4-8-DF', unitPrice: toCents(4.62) },
      { kind: 'volume', sku: 'LBR-2X4-8-DF', breaks: [{ minQty: 250, unitPrice: toCents(3.98) }] },
    ]);

    expect(engineWithSkuTier.quote(product(), 10, ACCOUNT).unitPrice).toBe(toCents(4.62));
    expect(engineWithSkuTier.quote(product(), 250, ACCOUNT).unitPrice).toBe(toCents(3.98));
  });

  it('reports no further break once the deepest one is reached', () => {
    expect(engine.quote(product(), 900, ACCOUNT).nextBreak).toBeUndefined();
  });
});
