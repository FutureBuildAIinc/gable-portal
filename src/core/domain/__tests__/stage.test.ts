// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { Order, OrderStage, ScopeItem } from '../project';
import { allowedTargets, canMoveToStage, systemAdvanceToInvoice } from '../stage';

/**
 * `Partial<T>` can't express "explicitly set this to undefined" under
 * exactOptionalPropertyTypes, but clearing a field is exactly what these tests
 * need (an order with no delivery date). This keeps the domain strict while
 * letting builders blank an optional field. The assertion in each builder is
 * the cost: callers are trusted not to blank a required one.
 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

/** Fixed 'now' for the guards; expiry has its own describe block. */
const NOW = '2026-08-01T00:00:00.000Z';

function makeOrder(overrides: Overrides<Order> = {}): Order {
  return {
    id: 'ord_1',
    projectId: 'prj_1',
    name: 'Framing package',
    stage: 'plan',
    fulfillment: 'delivery',
    requestedDate: '2026-08-14T00:00:00.000Z',
    deliveryAddressId: 'addr_shop',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    sortOrder: 0,
    ...overrides,
  } as Order;
}

function catalogItem(overrides: Overrides<ScopeItem> = {}): ScopeItem {
  return {
    id: 'si_1',
    orderId: 'ord_1',
    kind: 'catalog',
    productId: 'p_1',
    snapshot: { sku: 'LBR-2X4-8-DF', name: "2x4x8' Douglas Fir" },
    qty: 100,
    uom: 'EA',
    unitPrice: 462,
    listPrice: 597,
    priceSource: 'erp',
    addedBy: 'user',
    addedAt: '2026-07-01T00:00:00.000Z',
    sortOrder: 0,
    ...overrides,
  } as ScopeItem;
}

function specialItem(overrides: Overrides<ScopeItem> = {}): ScopeItem {
  return catalogItem({
    id: 'si_special',
    kind: 'special',
    productId: undefined,
    snapshot: { sku: 'SO-A1B2C3', name: 'Custom mahogany entry door' },
    unitPrice: undefined,
    priceSource: 'unpriced',
    ...overrides,
  });
}

describe('stage machine — forward moves', () => {
  it('lets a fully ERP-priced order skip the quote desk entirely', () => {
    // The core promise of account pricing: if the ERP already priced it,
    // nobody needs to hand-quote it.
    const result = canMoveToStage(makeOrder(), 'order', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effects).toEqual([{ kind: 'create-sales-order' }]);
    }
  });

  it('blocks the direct route when a special-order line has no dealer price', () => {
    const result = canMoveToStage(makeOrder(), 'order', {
      items: [catalogItem(), specialItem()],
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Custom mahogany entry door');
      expect(result.error).toContain('quote desk');
      // These sentences are read by a contractor, so they have to be grammatical.
      expect(result.error).toContain('1 item needs');
    }
  });

  it('agrees subject and verb when several items block the move', () => {
    const items = [
      specialItem({ id: 'a', snapshot: { sku: 'SO-1', name: 'Door A' } }),
      specialItem({ id: 'b', snapshot: { sku: 'SO-2', name: 'Door B' } }),
    ];
    const result = canMoveToStage(makeOrder(), 'order', { items, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('2 items need ');
  });

  it('allows the direct route once the quote desk has priced the special line', () => {
    const priced = specialItem({ unitPrice: 128_000, priceSource: 'quoted' });
    const result = canMoveToStage(makeOrder(), 'order', {
      items: [catalogItem(), priced],
      now: NOW,
    });

    expect(result.ok).toBe(true);
  });

  it('names several blocking items without listing all of them', () => {
    const items = [
      specialItem({ id: 'a', snapshot: { sku: 'SO-1', name: 'Door A' } }),
      specialItem({ id: 'b', snapshot: { sku: 'SO-2', name: 'Door B' } }),
      specialItem({ id: 'c', snapshot: { sku: 'SO-3', name: 'Door C' } }),
    ];
    const result = canMoveToStage(makeOrder(), 'order', { items, now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Door A');
      expect(result.error).toContain('and 1 more');
      expect(result.error).not.toContain('Door C');
    }
  });

  it('refuses to move an empty order forward', () => {
    const result = canMoveToStage(makeOrder(), 'quote', { items: [], now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('empty');
  });

  it('requires a date before an order can be submitted', () => {
    const order = makeOrder({ requestedDate: undefined });
    const result = canMoveToStage(order, 'order', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('date');
  });

  it('requires an address for delivery but not for will-call', () => {
    const items = [catalogItem()];

    const delivery = makeOrder({ fulfillment: 'delivery', deliveryAddressId: undefined });
    expect(canMoveToStage(delivery, 'order', { items, now: NOW }).ok).toBe(false);

    const willcall = makeOrder({ fulfillment: 'willcall', deliveryAddressId: undefined });
    expect(canMoveToStage(willcall, 'order', { items, now: NOW }).ok).toBe(true);
  });

  it('withdraws from the quote desk when going Quote -> Order', () => {
    const order = makeOrder({ stage: 'quote' });
    const result = canMoveToStage(order, 'order', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.effects).toEqual([
        { kind: 'withdraw-from-quote-desk' },
        { kind: 'create-sales-order' },
      ]);
    }
  });

  it('lets an unpriced special-order line go to the quote desk — that is its purpose', () => {
    const result = canMoveToStage(makeOrder(), 'quote', { items: [specialItem()], now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe('stage machine — Invoice is the supplier’s move', () => {
  it('refuses a contractor-driven drag into Invoice', () => {
    const order = makeOrder({ stage: 'order' });
    const result = canMoveToStage(order, 'invoice', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('supplier');
  });

  it('allows the system to advance a delivered order', () => {
    expect(systemAdvanceToInvoice(makeOrder({ stage: 'order' })).ok).toBe(true);
  });

  it('will not let the system skip stages', () => {
    expect(systemAdvanceToInvoice(makeOrder({ stage: 'plan' })).ok).toBe(false);
  });
});

describe('stage machine — backward moves', () => {
  it('withdraws a quote when pulled back to Plan', () => {
    const order = makeOrder({ stage: 'quote' });
    const result = canMoveToStage(order, 'plan', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.effects).toEqual([{ kind: 'withdraw-from-quote-desk' }]);
  });

  it('cancels the sales order when pulled back from Order', () => {
    const order = makeOrder({ stage: 'order' });
    const result = canMoveToStage(order, 'plan', { items: [catalogItem()], now: NOW });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.effects).toEqual([{ kind: 'cancel-sales-order' }]);
  });

  it('never lets an invoiced order be un-invoiced', () => {
    const order = makeOrder({ stage: 'invoice' });
    for (const target of ['plan', 'quote', 'order'] as OrderStage[]) {
      expect(canMoveToStage(order, target, { items: [catalogItem()], now: NOW }).ok).toBe(false);
    }
  });

  it('rejects a move to the stage it is already in', () => {
    const result = canMoveToStage(makeOrder(), 'plan', { items: [catalogItem()], now: NOW });
    expect(result.ok).toBe(false);
  });
});

describe('allowedTargets drives which drop zones light up', () => {
  it('offers Quote and Order for a clean priced order', () => {
    expect(allowedTargets(makeOrder(), { items: [catalogItem()], now: NOW })).toEqual([
      'quote',
      'order',
    ]);
  });

  it('offers only Quote when a special-order line is unpriced', () => {
    expect(
      allowedTargets(makeOrder(), { items: [catalogItem(), specialItem()], now: NOW }),
    ).toEqual(['quote']);
  });

  it('offers nothing forward for an empty order', () => {
    expect(allowedTargets(makeOrder(), { items: [], now: NOW })).toEqual([]);
  });
});
