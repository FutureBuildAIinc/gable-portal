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
import { GableHttpError, GableNetworkError } from '../errors';
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
    orderFeed: vi.fn(async () => {
      calls.push('orderFeed');
      return { orders: [PLACED_ORDER], etag: '"v1"', latestChange: undefined };
    }),
    order: vi.fn(async () => {
      calls.push('order');
      return PLACED_ORDER;
    }),
    cancelOrder: vi.fn(),
    setOrderProject: vi.fn(),
    deliveries: vi.fn(async () => []),
    requestReschedule: vi.fn(),
    reschedule: vi.fn(async () => null),
    categories: vi.fn(async () => []),
    volumeBreaks: vi.fn(async () => []),
    quotes: vi.fn(async () => []),
    quote: vi.fn(),
    createQuote: vi.fn(),
    acceptQuote: vi.fn(),
    declineQuote: vi.fn(),
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

  /**
   * The other side of that rule, and the one it used to get wrong.
   *
   * `POST /checkout` is the commit. Once it answers with an `order_id` the
   * order EXISTS at the dealer — the follow-up `GET /orders/{id}` is only a
   * read, and `gable` restarts on deploy, so a 5xx on that read is an ordinary
   * Tuesday. Treating it as a refusal walked the card back to Plan, dropped the
   * ERP id, and told the contractor "Kelly-Fradet did not accept this order"
   * while the yard was picking it. The only recovery on offer was to drag it to
   * Order again, which places it a SECOND time.
   */
  it('keeps a placed order when only the confirming read fails', async () => {
    const stub = stubClient({
      order: vi.fn(() =>
        Promise.reject(
          new GableHttpError(500, 'The supplier refused GET /orders/{id} (HTTP 500).'),
        ),
      ) as GableClient['order'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));
    await vi.waitFor(() =>
      expect(ordersStore.get().byId[orderId]?.salesOrderId).toBe(`gso_${PLACED_ORDER.id}`),
    );

    const order = ordersStore.get().byId[orderId];
    // The card stays where the contractor put it: the order is real.
    expect(order?.stage).toBe('order');
    // A REAL ERP id, not the pending placeholder — this is what stops the next
    // poll minting a second card for the same order.
    expect(salesOrdersStore.get().byId[pendingSalesOrderIdFor(orderId)]).toBeUndefined();
    const salesOrder = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`];
    expect(salesOrder?.status).toBe('submitted');
    expect(salesOrder?.number).toBe('GBL-aa11bb22');
    // And it must not be reported as a refusal.
    expect(activityStore.get().entries.some((entry) => entry.kind === 'order.rejected')).toBe(
      false,
    );
    expect(salesOrder?.tracking[0]?.note).toContain('Placed with Kelly-Fradet');
  });

  it('lets the next status poll fill in an order whose confirming read failed', async () => {
    const stub = stubClient({
      order: vi.fn(() =>
        Promise.reject(
          new GableHttpError(500, 'The supplier refused GET /orders/{id} (HTTP 500).'),
        ),
      ) as GableClient['order'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() =>
      expect(ordersStore.get().byId[orderId]?.salesOrderId).toBe(`gso_${PLACED_ORDER.id}`),
    );

    await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    });

    // ONE card, patched — not a second one alongside it.
    expect(listOf(salesOrdersStore.get())).toHaveLength(1);
    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('confirmed');
    expect(ordersStore.get().byId[orderId]?.stage).toBe('order');
  });

  /**
   * PIN, not a passing guard. `it.fails` asserts the CURRENT behaviour is
   * wrong: when somebody fixes this, this line starts failing and forces the
   * conversation.
   *
   * The case the fix above cannot reach. `POST /checkout` is not idempotent and
   * carries no client key, so a request that TIMES OUT is genuinely ambiguous:
   * the order may never have been created, or it may have been created and the
   * response lost. The portal resolves that ambiguity as "refused" — the card
   * walks back to Plan and the contractor is told the dealer did not accept it.
   *
   * Half the time that is a lie, and the recovery the UI offers (drag it to
   * Order again) places the order a second time. On a framing package that is
   * two truckloads of lumber and two invoices.
   *
   * Why this is a pin: the correct fix is cross-repo and is a product decision.
   *
   *  1. `gable` accepts an idempotency key on `POST /checkout` and returns the
   *     same order for a repeat. Correct, and it needs an endpoint change.
   *  2. The portal reconciles on timeout — `GET /orders` filtered to the last
   *     few minutes, matched against this order's lines — and adopts a match.
   *     Heuristic, and a wrong match files someone else's order on this job.
   *  3. The card goes to a third state ("we don't know — check with your
   *     supplier") that is neither placed nor refused, and refuses to resubmit
   *     until somebody looks. Honest, safe, and a new UI state.
   *
   * (1) is the real answer and is not this repository's to make.
   */
  it.fails('KNOWN BUG: a checkout that TIMES OUT is reported as a refusal', async () => {
    const stub = stubClient({
      checkout: vi.fn(() =>
        Promise.reject(
          new GableNetworkError('The supplier did not answer POST /checkout in time.'),
        ),
      ) as GableClient['checkout'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(activityStore.get().entries.length).toBeGreaterThan(0));

    // A timeout is not a refusal. The order may well be sitting in the dealer's
    // ERP, so the card must not walk back to Plan — where the only thing the
    // contractor can do is place it again.
    expect(ordersStore.get().byId[orderId]?.stage).toBe('order');
    expect(activityStore.get().entries.some((entry) => entry.kind === 'order.rejected')).toBe(
      false,
    );
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

describe('the capability inventory is the honest one', () => {
  it('declares a real quote desk, a real cancel, and a reschedule that only REQUESTS', () => {
    wire(stubClient().client);
    const { capabilities, kind } = getContext().supplier;

    expect(kind).toBe('gable');
    // All three of these used to be refusals in this file, because `gable` had
    // no endpoint for any of them.
    expect(capabilities.quoteDesk).toBe(true);
    expect(capabilities.quoteDecisions).toBe(true);
    expect(capabilities.cancellation).toBe(true);
    // The one that must NOT become `applies`: `POST /deliveries/{id}/reschedule`
    // answers 202 with `applied: false` and never writes `delivery_routes`.
    expect(capabilities.reschedule).toBe('requests');
    expect(capabilities.changeFeed).toBe(true);
  });
});

describe('status is read from the ERP, not advanced by a timer', () => {
  it('adopts a status change on the next poll', async () => {
    let current: GableOrder = PLACED_ORDER;
    const stub = stubClient({
      orderFeed: vi.fn(async () => ({
        orders: [current],
        etag: '"v1"',
        latestChange: undefined,
      })) as GableClient['orderFeed'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls).toContain('checkout'));

    current = { ...PLACED_ORDER, status: 'FULFILLED' };
    const result = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    });

    expect(result.changed).toBe(1);
    expect(result.notModified).toBe(false);
    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('delivered');
  });

  it('ignores ERP orders that have no card on this board', async () => {
    // A customer's history includes counter sales and phone orders. Inventing
    // cards for them would rewrite the contractor's own project structure.
    const stub = stubClient();
    wire(stub.client);

    const result = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: 'Kelly-Fradet',
    });

    expect(result.changed).toBe(0);
    expect(listOf(salesOrdersStore.get())).toHaveLength(0);
    // And no delivery read either: the feed page held nothing this board knows
    // about, so there was nothing to refine.
    expect(stub.client.deliveries).not.toHaveBeenCalled();
  });

  it('keeps the observed history rather than replacing it with one data point', async () => {
    let current: GableOrder = PLACED_ORDER;
    const stub = stubClient({
      orderFeed: vi.fn(async () => ({
        orders: [current],
        etag: '"v1"',
        latestChange: undefined,
      })) as GableClient['orderFeed'],
    });
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
