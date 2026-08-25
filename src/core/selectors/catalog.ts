// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import {
  type Category,
  type PriceQuote,
  type Product,
  isStocked,
  totalOnHand,
} from '../domain/catalog';
import { searchProducts } from './order';

/**
 * The read model behind Catalog as a destination.
 *
 * The difference between this and the add-items sheet is the price. That sheet
 * shows LIST, and says so, because it is a fast way to find a SKU mid-order.
 * Browsing is the other job: a contractor opens the catalog to find out what
 * something costs THEM, and a list price there would be the one number they
 * came for, wrong.
 *
 * Pricing is injected rather than imported, the same way `buildOrderDetail`
 * takes `quoteFor` — core stays free of the ERP, and a real dealer's pricing
 * API drops in without touching this file.
 */

export interface CatalogRow {
  product: Product;
  /** The contractor's resolved price. Undefined only if the engine declines. */
  quote: PriceQuote | undefined;
  onHand: number;
  stocked: boolean;
  /**
   * The supplier's published lead time, or undefined when it has published
   * none. Undefined is NOT zero — see `Product.leadTimeDays`. A row that shows
   * "special order — 0 days" for a product nobody has dated is exactly the
   * fiction the lead-time work exists to remove.
   */
  leadTimeDays: number | undefined;
}

export interface CatalogBranch {
  category: Category;
  /** Products in this category AND everything beneath it. */
  count: number;
  children: CatalogBranch[];
}

export interface BrowseInput {
  products: readonly Product[];
  categories: readonly Category[];
  /** Free text. Wins over category when present — searching is a jump, not a filter. */
  query?: string | undefined;
  categoryId?: string | undefined;
  brandId?: string | undefined;
  quoteFor: (product: Product) => PriceQuote | undefined;
  limit?: number;
}

/**
 * Every descendant of a category, itself included.
 *
 * Browsing "Lumber" has to show the studs filed under Framing Lumber two
 * levels down, or the top-level categories look empty and the tree reads as
 * broken. Same cascade the pricing rules use, for the same reason.
 */
export function categoryAndDescendants(
  categories: readonly Category[],
  categoryId: string,
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const siblings = childrenOf.get(category.parentId) ?? [];
    siblings.push(category.id);
    childrenOf.set(category.parentId, siblings);
  }

  const out = new Set<string>([categoryId]);
  const queue = [categoryId];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    for (const child of childrenOf.get(next) ?? []) {
      if (out.has(child)) continue; // a cycle in hand-edited data must not hang the UI
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** The category tree, with counts that include everything underneath. */
export function catalogTree(
  categories: readonly Category[],
  products: readonly Product[],
): CatalogBranch[] {
  const directCount = new Map<string, number>();
  for (const product of products) {
    directCount.set(product.categoryId, (directCount.get(product.categoryId) ?? 0) + 1);
  }

  const build = (category: Category): CatalogBranch => {
    const children = categories
      .filter((candidate) => candidate.parentId === category.id)
      .map(build)
      .sort((a, b) => a.category.name.localeCompare(b.category.name));
    return {
      category,
      count:
        (directCount.get(category.id) ?? 0) + children.reduce((sum, child) => sum + child.count, 0),
      children,
    };
  };

  return categories
    .filter((category) => !category.parentId)
    .map(build)
    .sort((a, b) => a.category.name.localeCompare(b.category.name));
}

export function browseCatalog(input: BrowseInput): CatalogRow[] {
  const limit = input.limit ?? 60;
  const query = input.query?.trim();

  // A search is a jump to a known thing, so it looks at the whole catalog
  // rather than the aisle the contractor happens to be standing in. Filtering
  // search by the current category is how you type a SKU you can see on a
  // delivery note and get told it does not exist.
  let matched: readonly Product[] = query
    ? searchProducts(input.products, query, input.products.length)
    : input.products;

  if (!query && input.categoryId) {
    const within = categoryAndDescendants(input.categories, input.categoryId);
    matched = matched.filter((product) => within.has(product.categoryId));
  }
  if (input.brandId) {
    matched = matched.filter((product) => product.brandId === input.brandId);
  }

  return matched.slice(0, limit).map((product) => ({
    product,
    quote: input.quoteFor(product),
    onHand: totalOnHand(product),
    stocked: isStocked(product),
    leadTimeDays: product.leadTimeDays,
  }));
}
