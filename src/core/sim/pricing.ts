// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { Category, PriceQuote, Product, VolumeBreak } from '../domain/catalog';
import type { EntityId } from '../lib/ids';
import type { Cents } from '../lib/money';

/**
 * The supplier's ERP pricing engine.
 *
 * This lives in `sim/` and NOT in `domain/` on purpose. Tiers, category rules,
 * and contract prices are the supplier's internal commercial machinery — the
 * contractor never sees them, they just see "my price". Modelling them in the
 * domain would leak the dealer's business logic into the portal and make the
 * eventual real-ERP integration a rewrite instead of a swap.
 *
 * When a real ERP connects, everything in this file is replaced by an API call
 * that returns the same `PriceQuote`. Nothing in `domain/` changes.
 */

export interface PricingTier {
  id: EntityId;
  name: string;
  /** Baseline discount off list applied to everything. */
  percentOffList: number;
}

export type PricingRule =
  /** A better discount on one category — "your rep got you 18% on lumber". */
  | {
      kind: 'category';
      tierId?: EntityId;
      accountId?: EntityId;
      categoryId: EntityId;
      percentOffList: number;
    }
  /** A locked price on a specific SKU, negotiated and immune to list changes. */
  | {
      kind: 'contract';
      accountId: EntityId;
      sku: string;
      unitPrice: Cents;
    }
  /** Buy more, pay less. The one piece of pricing mechanics we surface. */
  | {
      kind: 'volume';
      sku?: string;
      categoryId?: EntityId;
      breaks: VolumeBreakRule[];
    };

/**
 * A break is either an absolute price or an extra percentage off.
 *
 * The distinction is load-bearing. An absolute break price is only meaningful
 * for ONE sku — a category spans a $5 stud and a $30 post, so "100+ costs
 * $4.28 each" is nonsense applied category-wide and would put obviously fake
 * numbers in front of a contractor. Category breaks must therefore be
 * relative; the engine resolves them against that product's own base price.
 */
export type VolumeBreakRule =
  | { minQty: number; unitPrice: Cents }
  | { minQty: number; extraPercentOff: number };

export interface PricingInput {
  accountId: EntityId;
  tierId: EntityId;
}

/**
 * Category id -> parent id. Category rules cascade down this tree: a dealer who
 * sets "18% off Lumber" means all of it, including Framing Lumber and Pressure
 * Treated beneath it. Matching category ids exactly would silently drop the
 * discount on every product that sits in a subcategory — which is most of them.
 */
export type CategoryParents = ReadonlyMap<EntityId, EntityId | undefined>;

/** Build the parent map from the catalog. Always pass this to createPricingEngine. */
export function categoryParentsFrom(categories: readonly Category[]): CategoryParents {
  return new Map(categories.map((category) => [category.id, category.parentId]));
}

export interface PricingEngine {
  quote(product: Product, qty: number, account: PricingInput): PriceQuote;
  quoteAll(products: readonly Product[], qty: number, account: PricingInput): PriceQuote[];
}

function applyPercentOff(listPrice: Cents, percent: number): Cents {
  return Math.round(listPrice * (1 - percent / 100));
}

/**
 * Precedence, most specific wins: contract price > account category rule >
 * tier category rule > tier baseline > list. Volume breaks are evaluated last
 * and only apply if they beat whatever the rules produced.
 */
export function createPricingEngine(
  tiers: readonly PricingTier[],
  rules: readonly PricingRule[],
  categoryParents: CategoryParents = new Map(),
): PricingEngine {
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));

  /**
   * The product's category and every ancestor above it, nearest first, so a
   * rule on a subcategory outranks one on its parent. Guards against a cycle in
   * malformed category data rather than hanging the pricing call.
   */
  function categoryChain(categoryId: EntityId): EntityId[] {
    const chain: EntityId[] = [];
    const seen = new Set<EntityId>();
    let current: EntityId | undefined = categoryId;
    while (current !== undefined && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = categoryParents.get(current);
    }
    return chain;
  }

  function matchesCategory(product: Product, ruleCategoryId: EntityId): number {
    // Returns depth: 0 = the product's own category, higher = further ancestor.
    return categoryChain(product.categoryId).indexOf(ruleCategoryId);
  }

  function contractPrice(product: Product, account: PricingInput): Cents | undefined {
    for (const rule of rules) {
      if (
        rule.kind === 'contract' &&
        rule.accountId === account.accountId &&
        rule.sku === product.sku
      ) {
        return rule.unitPrice;
      }
    }
    return undefined;
  }

  function baseUnitPrice(product: Product, account: PricingInput): Cents {
    // 1. Contract price on this exact SKU for this account.
    const contract = contractPrice(product, account);
    if (contract !== undefined) return contract;

    // 2. Category rule bound to the account, then to the tier. Rules cascade
    //    down the category tree; the nearest matching level wins.
    let accountPercent: number | undefined;
    let accountDepth = Number.POSITIVE_INFINITY;
    let tierPercent: number | undefined;
    let tierDepth = Number.POSITIVE_INFINITY;

    for (const rule of rules) {
      if (rule.kind !== 'category') continue;
      const depth = matchesCategory(product, rule.categoryId);
      if (depth < 0) continue;

      if (rule.accountId === account.accountId) {
        // Nearer category wins; at equal depth take the better discount.
        if (
          depth < accountDepth ||
          (depth === accountDepth && rule.percentOffList > (accountPercent ?? 0))
        ) {
          accountPercent = rule.percentOffList;
          accountDepth = depth;
        }
      } else if (rule.tierId === account.tierId && rule.accountId === undefined) {
        if (
          depth < tierDepth ||
          (depth === tierDepth && rule.percentOffList > (tierPercent ?? 0))
        ) {
          tierPercent = rule.percentOffList;
          tierDepth = depth;
        }
      }
    }

    // An account-specific rule outranks a tier rule regardless of depth — it
    // was negotiated for this contractor.
    const bestPercent = accountPercent ?? tierPercent;
    if (bestPercent !== undefined) return applyPercentOff(product.listPrice, bestPercent);

    // 3. Tier baseline, else list.
    const tier = tierById.get(account.tierId);
    return tier ? applyPercentOff(product.listPrice, tier.percentOffList) : product.listPrice;
  }

  /**
   * Resolves every applicable break to an absolute unit price for THIS product,
   * so callers (and the UI) only ever deal in real numbers.
   */
  function volumeBreaksFor(
    product: Product,
    base: Cents,
    hasContractPrice: boolean,
  ): VolumeBreak[] {
    const found: VolumeBreak[] = [];

    for (const rule of rules) {
      if (rule.kind !== 'volume') continue;
      const bySku = rule.sku === product.sku;
      const byCategory =
        rule.categoryId !== undefined && matchesCategory(product, rule.categoryId) >= 0;
      if (!bySku && !byCategory) continue;

      // A negotiated contract price is locked — a category-wide volume discount
      // must not stack on top of it, or the dealer is being double-dipped. A
      // break written for THIS sku is different: that is a deliberate volume
      // tier on the contracted item, so it still applies.
      if (hasContractPrice && !bySku) continue;

      for (const brk of rule.breaks) {
        if ('unitPrice' in brk) {
          // Absolute prices are only trustworthy when the rule names a sku.
          if (bySku) found.push({ minQty: brk.minQty, unitPrice: brk.unitPrice });
        } else {
          found.push({
            minQty: brk.minQty,
            unitPrice: applyPercentOff(base, brk.extraPercentOff),
          });
        }
      }
    }

    return found.sort((a, b) => a.minQty - b.minQty);
  }

  function quote(product: Product, qty: number, account: PricingInput): PriceQuote {
    const base = baseUnitPrice(product, account);
    const breaks = volumeBreaksFor(product, base, contractPrice(product, account) !== undefined);

    // Best break the contractor already qualifies for.
    let unitPrice = base;
    for (const brk of breaks) {
      if (qty >= brk.minQty && brk.unitPrice < unitPrice) unitPrice = brk.unitPrice;
    }

    // The next break worth telling them about: more qty AND a better price
    // than what they're currently paying. Anything else is noise.
    const nextBreak = breaks.find((brk) => brk.minQty > qty && brk.unitPrice < unitPrice);

    return {
      sku: product.sku,
      unitPrice,
      listPrice: product.listPrice,
      qty,
      ...(nextBreak ? { nextBreak } : {}),
    };
  }

  return {
    quote,
    quoteAll(products, qty, account) {
      return products.map((product) => quote(product, qty, account));
    },
  };
}
