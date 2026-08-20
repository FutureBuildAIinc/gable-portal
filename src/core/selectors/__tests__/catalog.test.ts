// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeEach, describe, expect, it } from 'vitest';
import { boot, getContext } from '../../boot';
import { catalogStore, sessionStore } from '../../stores/root';
import { browseCatalog, catalogTree, categoryAndDescendants } from '../catalog';

/**
 * The catalog destination's read model.
 *
 * The behaviours worth pinning are the two that would quietly make the catalog
 * useless: a category tree whose parents look empty, and a search that only
 * looks in the aisle you happen to be standing in.
 */

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

function quoteFor() {
  const { pricing } = getContext();
  const account = sessionStore.get().account;
  return (product: Parameters<typeof pricing.quote>[0]) =>
    account ? pricing.quote(product, 1, { accountId: account.id, tierId: 'tier_pro' }) : undefined;
}

describe('the category tree', () => {
  it('counts everything beneath a parent, not just its direct children', () => {
    const { categories, products } = catalogStore.get();
    const tree = catalogTree(categories, products);

    const withChildren = tree.find((branch) => branch.children.length > 0);
    expect(withChildren, 'the seed should have at least one nested category').toBeDefined();
    if (!withChildren) return;

    const childTotal = withChildren.children.reduce((sum, child) => sum + child.count, 0);
    // A parent whose products all live in its children would otherwise show 0
    // and read as an empty aisle.
    expect(withChildren.count).toBeGreaterThanOrEqual(childTotal);
    expect(withChildren.count).toBeGreaterThan(0);
  });

  it('walks the whole subtree, and a cycle in hand-edited data cannot hang it', () => {
    const cyclic = [
      { id: 'a', name: 'A', parentId: null, slug: 'a' },
      { id: 'b', name: 'B', parentId: 'a', slug: 'b' },
      // b is its own grandparent — nonsense, but it must not spin forever.
      { id: 'c', name: 'C', parentId: 'b', slug: 'c' },
      { id: 'a2', name: 'A2', parentId: 'c', slug: 'a2' },
    ] as never;

    const reached = categoryAndDescendants(cyclic, 'a');
    expect([...reached].sort()).toEqual(['a', 'a2', 'b', 'c']);
  });
});

describe('browsing', () => {
  it('filters a category by everything underneath it', () => {
    const { categories, products } = catalogStore.get();
    const parent = catalogTree(categories, products).find(
      (branch) => branch.children.length > 0 && branch.count > 0,
    );
    if (!parent) return;

    const rows = browseCatalog({
      products,
      categories,
      categoryId: parent.category.id,
      quoteFor: quoteFor(),
    });

    expect(rows.length).toBe(parent.count);
    const within = categoryAndDescendants(categories, parent.category.id);
    for (const row of rows) expect(within.has(row.product.categoryId)).toBe(true);
  });

  /**
   * A search is a jump to a known thing. Narrowing it by the aisle the
   * contractor is standing in is how you type a SKU off a delivery note and
   * get told it does not exist.
   */
  it('searches the whole catalog even while a category is selected', () => {
    const { categories, products } = catalogStore.get();
    const target = products.find((product) => product.sku.startsWith('PLY-'));
    expect(target).toBeDefined();
    if (!target) return;

    // The category must NOT contain the target, ancestors included. Picking
    // "the first top-level category that isn't the target's" is not enough:
    // it can be the target's own PARENT, and then filtering by it keeps the
    // target anyway — this test passed with the bug reintroduced until the
    // subtree was checked explicitly.
    const otherCategory = categories.find(
      (category) =>
        !category.parentId &&
        !categoryAndDescendants(categories, category.id).has(target.categoryId),
    );
    expect(otherCategory, 'need a category that genuinely excludes the target').toBeDefined();
    if (!otherCategory) return;
    expect(categoryAndDescendants(categories, otherCategory.id).has(target.categoryId)).toBe(false);

    const rows = browseCatalog({
      products,
      categories,
      query: target.sku,
      categoryId: otherCategory.id,
      quoteFor: quoteFor(),
    });

    expect(rows.some((row) => row.product.sku === target.sku)).toBe(true);
  });

  it('prices at the contractor rate, not list', () => {
    const { categories, products } = catalogStore.get();
    const rows = browseCatalog({ products, categories, quoteFor: quoteFor() });

    const discounted = rows.filter(
      (row) => row.quote !== undefined && row.quote.unitPrice < row.product.listPrice,
    );
    // The seeded account has an 18%-off category rule and a contract SKU, so
    // a catalog showing list everywhere would mean the pricing never ran.
    expect(discounted.length).toBeGreaterThan(0);
  });

  it('reports stock and lead time so a special order is visible before ordering', () => {
    const { categories, products } = catalogStore.get();
    const rows = browseCatalog({ products, categories, quoteFor: quoteFor() });

    expect(rows.some((row) => row.stocked)).toBe(true);
    for (const row of rows) {
      if (!row.stocked) expect(row.leadTimeDays).toBeGreaterThan(0);
    }
  });
});
