// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../../boot';
import { seedTemplates } from '../../data/template-seed';
import { scopeStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import { moveOrderToStage } from '../orders';
import {
  addCatalogItem,
  addSpecialItem,
  applyTemplate,
  removeItem,
  updateItemQtyDetailed,
} from '../scope';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
});

const PERGOLA = 'ord_miller_pergola'; // the seeded empty draft

function itemsOf(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

describe('adding scope', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('prices a catalog line through the ERP on the way in', () => {
    const result = addCatalogItem({ orderId: PERGOLA, product: 'LBR-2X4-8-DF', qty: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priceSource).toBe('erp');
      // Contract price on this SKU, well under the $5.97 list.
      expect(result.value.unitPrice).toBe(462);
      expect(result.value.listPrice).toBe(597);
    }
  });

  it('merges a repeat SKU into the existing line instead of duplicating it', () => {
    addCatalogItem({ orderId: PERGOLA, product: 'PT-4X4-8', qty: 4 });
    addCatalogItem({ orderId: PERGOLA, product: 'PT-4X4-8', qty: 6 });

    const items = itemsOf(PERGOLA);
    expect(items).toHaveLength(1);
    expect(items[0]?.qty).toBe(10);
  });

  it('rejects an unknown product by name', () => {
    const result = addCatalogItem({ orderId: PERGOLA, product: 'NOPE-123', qty: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('NOPE-123');
  });

  it('captures a special order unpriced, with an SO- sku', () => {
    const result = addSpecialItem({
      orderId: PERGOLA,
      description: 'Custom cedar pergola rafters, 16ft',
      qty: 8,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('special');
      expect(result.value.snapshot.sku.startsWith('SO-')).toBe(true);
      // Crucially unpriced — nobody has agreed to a number yet.
      expect(result.value.unitPrice).toBeUndefined();
      expect(result.value.priceSource).toBe('unpriced');
    }
  });

  it('marks a contractor guess as an estimate rather than a real price', () => {
    const result = addSpecialItem({
      orderId: PERGOLA,
      description: 'Custom bracket',
      qty: 2,
      estimatedUnitPrice: 4500,
    });
    if (result.ok) expect(result.value.priceSource).toBe('estimate');
  });
});

describe('quantity changes re-ask the ERP for a price', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('drops the unit price when a volume break is crossed', () => {
    const added = addCatalogItem({ orderId: PERGOLA, product: 'LBR-2X4-10-DF', qty: 10 });
    if (!added.ok) throw new Error(added.error);
    const before = added.value.unitPrice as number;

    const bumped = updateItemQtyDetailed(added.value.id, 100);
    expect(bumped.ok).toBe(true);
    if (bumped.ok) {
      expect(bumped.value.priceChanged).toBeDefined();
      expect(bumped.value.item.unitPrice).toBeLessThan(before);
      // $7.48 list -> 18% off lumber = $6.13, then 7% more at the 100+ break.
      expect(bumped.value.item.unitPrice).toBe(570);
    }
  });

  it('raises it again when the quantity falls back below the break', () => {
    const added = addCatalogItem({ orderId: PERGOLA, product: 'LBR-2X4-10-DF', qty: 100 });
    if (!added.ok) throw new Error(added.error);

    const reduced = updateItemQtyDetailed(added.value.id, 5);
    if (reduced.ok) {
      expect(reduced.value.item.unitPrice).toBeGreaterThan(570);
      expect(reduced.value.priceChanged).toBeDefined();
    }
  });

  it('reports no price change when the quantity stays in the same band', () => {
    const added = addCatalogItem({ orderId: PERGOLA, product: 'LBR-2X4-10-DF', qty: 10 });
    if (!added.ok) throw new Error(added.error);

    const nudged = updateItemQtyDetailed(added.value.id, 12);
    if (nudged.ok) expect(nudged.value.priceChanged).toBeUndefined();
  });

  it('refuses a zero quantity rather than silently deleting the line', () => {
    const added = addCatalogItem({ orderId: PERGOLA, product: 'PT-4X4-8', qty: 3 });
    if (!added.ok) throw new Error(added.error);

    const result = updateItemQtyDetailed(added.value.id, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Remove the line');
  });
});

describe('scope is locked once the supplier has the order', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('blocks edits on an order sitting at the quote desk', () => {
    const result = addCatalogItem({ orderId: 'ord_anderson', product: 'PT-4X4-8', qty: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('quote desk');
  });

  it('blocks edits on a placed order', () => {
    const result = addCatalogItem({ orderId: 'ord_wilson_frame', product: 'PT-4X4-8', qty: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already been placed');
  });

  it('blocks removal on a placed order too', () => {
    const existing = itemsOf('ord_wilson_frame')[0];
    if (!existing) throw new Error('expected seeded items');
    expect(removeItem(existing.id).ok).toBe(false);
  });

  it('allows edits again once the order is pulled back to Plan', () => {
    expect(moveOrderToStage('ord_anderson', 'plan').ok).toBe(true);
    expect(addCatalogItem({ orderId: 'ord_anderson', product: 'PT-4X4-8', qty: 1 }).ok).toBe(true);
  });
});

describe('BoM templates', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('applies every line of a starter template', () => {
    const template = seedTemplates()[0];
    if (!template) throw new Error('expected templates');

    const result = applyTemplate(PERGOLA, template);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.added).toBe(template.items.length);
    expect(itemsOf(PERGOLA)).toHaveLength(template.items.length);
  });

  it('merges into lines the order already had rather than duplicating', () => {
    const template = seedTemplates()[0];
    if (!template) throw new Error('expected templates');
    const first = template.items[0];
    if (!first) throw new Error('expected template items');

    addCatalogItem({ orderId: PERGOLA, product: first.productId, qty: 2 });
    const result = applyTemplate(PERGOLA, template);

    if (result.ok) expect(result.value.merged).toBe(1);
    expect(itemsOf(PERGOLA)).toHaveLength(template.items.length);
  });

  it('resolves every template line to a real product', () => {
    for (const template of seedTemplates()) {
      boot({ reset: true, seed: 20_260_730 });
      const result = applyTemplate(PERGOLA, template);
      expect(result.ok).toBe(true);
      // A template that silently drops lines would produce a short takeoff.
      if (result.ok) expect(result.value.added).toBe(template.items.length);
    }
  });
});
