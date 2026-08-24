// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrder, moveOrderToStage } from '../../actions/orders';
import { addCatalogItem } from '../../actions/scope';
import { boot, getContext, installSupplier } from '../../boot';
import { addDays } from '../../lib/time';
import {
  activityStore,
  catalogStore,
  ordersStore,
  projectsStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
} from '../../stores/root';
import { emptyCollection, listOf } from '../../stores/store';
import type { GableClient } from '../client';
import { GableHttpError } from '../errors';
import { catalogStateFrom } from '../mapper';
import { createGablePricingEngine } from '../pricing';
import type { GableCatalogProduct, GableOrder } from '../schema';
import { resetGableState } from '../store';
import { createGableSupplier, pendingSalesOrderIdFor, syncOrderStatus } from '../supplier';

/**
 * The wired supplier, driven end-to-end against a stub `gable`.
 *
 * The board is a synchronous machine and the ERP is not, so the interesting
 * behaviour is entirely in what happens between the drag and the answer:
 *
 *  - the ERP cart is CLEARED before checkout, or an abandoned session's lines
 *    ride along on someone's real order;
 *  - a refused order walks the card back, instead of leaving it in Order with
 *    nothing behind it;
 *  - a special-order line is refused BEFORE the ERP is touched, because
 *    `gable`'s cart takes a product id and a custom door does not have one;
 *  - "cancel" does not fake a cancellation `gable` has no endpoint for.
 */

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

const PRODUCT: GableCatalogProduct = {
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

const PLACED_ORDER: GableOrder = {
  id: 'aa11bb22-cccc-dddd-eeee-ffff00001111',
  status: 'CONFIRMED',
  total_amount: 198,
  created_at: '2026-08-24T17:00:00-07:00',
  lines: [
    {
      product_id: PRODUCT.id,
      product_sku: PRODUCT.sku,
      product_name: PRODUCT.name,
      quantity: 40,
      price_each: 4.95,
    },
  ],
};

interface Stub {
  client: GableClient;
  calls: string[];
  cartItems: { id: string; product_id: string; quantity: number }[];
}

function stubClient(overrides: Partial<GableClient> = {}, seedCart: Stub['cartItems'] = []): Stub {
  const calls: string[] = [];
  const cartItems = [...seedCart];

  const cart = () => ({
    id: 'cart-1',
    items: cartItems.map((item) => ({
      ...item,
      product_sku: 'X',
      product_name: 'X',
      image_url: '',
      unit_price: 4.95,
      line_total: 4.95 * item.quantity,
      available: 0,
    })),
    item_count: cartItems.length,
    subtotal: 0,
  });

  const base: GableClient = {
    login: vi.fn(),
    logout: vi.fn(),
    config: vi.fn(),
    dashboard: vi.fn(),
    catalog: vi.fn(async () => [PRODUCT]),
    catalogProduct: vi.fn(),
    cart: vi.fn(async () => {
      calls.push('cart');
      return cart();
    }),
    addCartItem: vi.fn(async (productId: string, quantity: number) => {
      calls.push(`add:${productId}:${quantity}`);
      cartItems.push({ id: `ci-${cartItems.length}`, product_id: productId, quantity });
      return cart();
    }),
    updateCartItem: vi.fn(),
    removeCartItem: vi.fn(async (itemId: string) => {
      calls.push(`remove:${itemId}`);
      const index = cartItems.findIndex((item) => item.id === itemId);
      if (index >= 0) cartItems.splice(index, 1);
      return cart();
    }),
    checkout: vi.fn(async () => {
      calls.push('checkout');
      return { order_id: PLACED_ORDER.id, message: 'Order placed successfully' };
    }),
    orders: vi.fn(async () => [PLACED_ORDER]),
    order: vi.fn(async () => {
      calls.push('order');
      return PLACED_ORDER;
    }),
    deliveries: vi.fn(async () => []),
    projects: vi.fn(async () => []),
    ...overrides,
  } as GableClient;

  return { client: base, calls, cartItems };
}

/** Boot, then swap in the ERP catalog + pricing + supplier, as `connect.ts` does. */
function wire(client: GableClient) {
  boot({ reset: true });
  /**
   * `connect.ts` drops the seeded demo scenario on connect — a board holding
   * both simulated orders and real ones is unreadable, and here it would also
   * make "ignores ERP orders with no card on this board" pass for the wrong
   * reason. Projects are left alone: the stub ERP returns none, and an order
   * needs somewhere to live.
   */
  ordersStore.set(emptyCollection());
  scopeStore.set(emptyCollection());
  quotesStore.set(emptyCollection());
  salesOrdersStore.set(emptyCollection());
  installSupplier({
    supplier: createGableSupplier({
      client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    }),
    pricing: createGablePricingEngine([PRODUCT]),
    catalog: catalogStateFrom([PRODUCT], 'Kelly-Fradet'),
  });
  getContext().sim.scheduler.stop();
}

/** A project + a priced order in `plan`, ready to be dragged to `order`. */
function plannedOrder(qty = 40): string {
  const project = listOf(projectsStore.get())[0];
  if (!project) throw new Error('expected the boot scenario to have left a project');
  const order = createOrder({
    projectId: project.id,
    name: 'Framing package',
    // The stage machine refuses a forward move without a date — and refuses a
    // date in the past. Sim time is the boot scenario's, so anchor off it.
    requestedDate: addDays(getContext().clock.nowIso(), 7),
  });
  if (!order.ok) throw new Error(order.error);
  const added = addCatalogItem({ orderId: order.value.id, product: PRODUCT.sku, qty });
  if (!added.ok) throw new Error(added.error);
  return order.value.id;
}

function scopeItems(orderId: string) {
  return listOf(scopeStore.get()).filter((item) => item.orderId === orderId);
}

/**
 * Turn the order's only line into a special-order one — no productId, which is
 * exactly the state `gable`'s cart cannot represent.
 */
function makeSpecial(orderId: string): void {
  const item = scopeItems(orderId)[0];
  if (!item) throw new Error('no scope item to convert');
  const collection = scopeStore.get();
  const { productId: _dropped, ...withoutProduct } = item;
  scopeStore.set({
    ...collection,
    byId: {
      ...collection.byId,
      [item.id]: { ...withoutProduct, kind: 'special', priceSource: 'quoted' },
    },
  });
}

beforeEach(() => {
  resetGableState();
});

describe('placing an order actually reaches the ERP', () => {
  it('clears the ERP cart before adding this order’s lines', async () => {
    // A per-customer cart survives reloads and browsers. Checking out on top of
    // one silently attaches an abandoned session's lines to a real order.
    const stub = stubClient({}, [{ id: 'stale-1', product_id: 'something-else', quantity: 99 }]);
    wire(stub.client);
    const orderId = plannedOrder();

    const moved = moveOrderToStage(orderId, 'order');
    expect(moved.ok).toBe(true);
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));

    expect(stub.calls.indexOf('remove:stale-1')).toBeLessThan(stub.calls.indexOf('checkout'));
    expect(stub.calls).toContain(`add:${PRODUCT.id}:40`);
  });

  it('records the ERP order id, so a later poll patches the same card', async () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => {
      const salesOrderId = ordersStore.get().byId[orderId]?.salesOrderId;
      expect(salesOrderId).toBe(`gso_${PLACED_ORDER.id}`);
    });

    const salesOrder = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`];
    expect(salesOrder?.status).toBe('confirmed');
    expect(salesOrder?.number).toBe('GBL-aa11bb22');
    // The optimistic placeholder must be gone, not left as a second card.
    expect(salesOrdersStore.get().byId[pendingSalesOrderIdFor(orderId)]).toBeUndefined();
  });

  it('shows a labelled placeholder while the ERP has not answered', () => {
    // Never resolves: this is the in-flight frame.
    const stub = stubClient({ cart: vi.fn(() => new Promise(() => {})) as GableClient['cart'] });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');

    const placeholder = salesOrdersStore.get().byId[pendingSalesOrderIdFor(orderId)];
    expect(placeholder?.status).toBe('submitted');
    expect(placeholder?.tracking[0]?.note).toContain('Kelly-Fradet');
  });
});

describe('a refused order does not leave a card claiming otherwise', () => {
  it('walks the stage move back when checkout fails', async () => {
    const stub = stubClient({
      checkout: vi.fn(() =>
        Promise.reject(new GableHttpError(500, 'The supplier refused POST /checkout (HTTP 500).')),
      ) as GableClient['checkout'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(ordersStore.get().byId[orderId]?.stage).not.toBe('order'));

    const order = ordersStore.get().byId[orderId];
    // Back where it came from — Plan — and not to a column it never used.
    expect(order?.stage).toBe('plan');
    expect(order?.salesOrderId).toBeUndefined();
    expect(salesOrdersStore.get().byId[pendingSalesOrderIdFor(orderId)]).toBeUndefined();
    expect(activityStore.get().entries.some((entry) => entry.kind === 'order.rejected')).toBe(true);
  });

  it('refuses a special-order line before touching the ERP at all', () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = plannedOrder();

    // A special line has no ERP product id — that is what "special" means, and
    // `gable`'s cart takes a product_id and nothing else.
    expect(scopeItems(orderId)).toHaveLength(1);
    makeSpecial(orderId);

    moveOrderToStage(orderId, 'order');

    expect(stub.calls).toEqual([]);
    expect(ordersStore.get().byId[orderId]?.stage).toBe('plan');
  });
});

describe('what gable cannot do is said, not simulated', () => {
  it('creates a quote record locally and sends nothing', () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = plannedOrder();

    getContext().supplier.submitToQuoteDesk(orderId);

    const quote = listOf(quotesStore.get())[0];
    expect(quote?.number.startsWith('LOCAL-')).toBe(true);
    // No expiry: an expiry implies a price is being held, and nobody at the
    // dealer has seen this.
    expect(quote?.expiresAt).toBeUndefined();
    expect(quote?.deskNote).toContain('Kelly-Fradet');
    expect(stub.calls).toEqual([]);
  });

  it('reports that it has no quote desk, so the UI can label the column', () => {
    wire(stubClient().client);
    expect(getContext().supplier.hasQuoteDesk).toBe(false);
    expect(getContext().supplier.kind).toBe('gable');
  });

  it('does not flip an order to cancelled — gable has no cancel endpoint', async () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));

    getContext().supplier.cancelWithSupplier(orderId);

    const salesOrder = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`];
    // Status UNCHANGED. Showing `cancelled` would assert something about the
    // ERP that is not true.
    expect(salesOrder?.status).toBe('confirmed');
    expect(salesOrder?.tracking.at(-1)?.note).toContain('cannot cancel');
  });
});

describe('status is read from the ERP, not advanced by a timer', () => {
  it('adopts a status change on the next poll', async () => {
    let current: GableOrder = PLACED_ORDER;
    const stub = stubClient({
      orders: vi.fn(async () => [current]) as GableClient['orders'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));

    current = { ...PLACED_ORDER, status: 'FULFILLED' };
    const changed = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    });

    expect(changed).toBe(1);
    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('delivered');
  });

  it('ignores ERP orders that have no card on this board', async () => {
    // A customer's history includes counter sales and phone orders. Inventing
    // cards for them would rewrite the contractor's own project structure.
    const stub = stubClient();
    wire(stub.client);

    const changed = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    });

    expect(changed).toBe(0);
    expect(listOf(salesOrdersStore.get())).toHaveLength(0);
  });

  it('keeps the observed history rather than replacing it with one data point', async () => {
    let current: GableOrder = PLACED_ORDER;
    const stub = stubClient({ orders: vi.fn(async () => [current]) as GableClient['orders'] });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));

    const deps = {
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    };
    current = { ...PLACED_ORDER, status: 'ON_HOLD' };
    await syncOrderStatus(deps);
    current = { ...PLACED_ORDER, status: 'FULFILLED' };
    await syncOrderStatus(deps);

    // `gable` publishes no order log, so this is the only history that exists.
    const tracking = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.tracking ?? [];
    expect(tracking.length).toBeGreaterThanOrEqual(3);
    expect(tracking.some((event) => event.note.includes('ON_HOLD'))).toBe(true);
  });
});

/** The catalog swap is what makes `addCatalogItem` find an ERP SKU at all. */
describe('the catalog the board prices against is the ERP’s', () => {
  it('replaces the seeded catalog wholesale', () => {
    wire(stubClient().client);

    const products = catalogStore.get().products;
    expect(products).toHaveLength(1);
    expect(products[0]?.sku).toBe('LUM-248-PREM');
    // Priced by the ERP's waterfall: 5.50 list, 4.95 contract.
    expect(products[0]?.listPrice).toBe(550);
  });

  it('extends a line at the ERP’s customer price', () => {
    wire(stubClient().client);
    const orderId = plannedOrder(40);

    const item = scopeItems(orderId)[0];
    expect(item?.unitPrice).toBe(495);
    expect(item?.listPrice).toBe(550);
  });
});
