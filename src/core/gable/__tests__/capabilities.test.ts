// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestDeliveryReschedule } from '../../actions/fulfillment';
import { createOrder, moveOrderToStage } from '../../actions/orders';
import { acceptSupplierQuote, declineSupplierQuote } from '../../actions/quotes';
import { addCatalogItem, addSpecialItem } from '../../actions/scope';
import { boot, getContext, installSupplier } from '../../boot';
import { addDays } from '../../lib/time';
import { catalogTree } from '../../selectors/catalog';
import { buildOrderDetail } from '../../selectors/order';
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
import { adoptOrderHistory, boardOrderIdFor } from '../history';
import { catalogStateFrom, productFrom } from '../mapper';
import { createGablePricingEngine } from '../pricing';
import type {
  GableCatalogProduct,
  GableCategoryNode,
  GableOrder,
  GableQuote,
  GableReschedule,
} from '../schema';
import { resetGableState } from '../store';
import { createGableSupplier, syncOrderStatus, syncQuotes } from '../supplier';

/**
 * The eight capabilities, driven through the seam rather than through the wire.
 *
 * `capability-client.test.ts` asserts the request and response shapes. This
 * file asserts what the PORTAL does with them, which is where the honesty
 * lives: a 202 that becomes "moved to Friday" on a board is a correct HTTP
 * call and a lie on a screen.
 *
 * Every refusal path is exercised with the real 409 envelope `gable` sends,
 * because the codes are the contract and the reasons are what a contractor
 * actually reads.
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
  category: 'Framing Lumber',
  species: 'SPF',
  grade: 'Premium',
  image_url: '',
  uom: 'EA',
  base_price: 5.5,
  customer_price: 4.95,
  price_source: 'CONTRACT',
  available: 400,
  in_stock: true,
  lead_time_days: 3,
  category_id: 'cat-framing',
};

const PLACED_ORDER: GableOrder = {
  id: 'aa11bb22-cccc-dddd-eeee-ffff00001111',
  status: 'CONFIRMED',
  total_amount: 198,
  created_at: '2026-08-24T17:00:00-07:00',
  updated_at: '2026-08-24T17:30:00-07:00',
  project_id: null,
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

const TREE: GableCategoryNode[] = [
  {
    id: 'cat-lumber',
    name: 'Lumber',
    slug: 'lumber',
    path: 'lumber',
    depth: 0,
    sort_order: 1,
    product_count: 1,
    children: [
      {
        id: 'cat-framing',
        name: 'Framing Lumber',
        slug: 'framing',
        path: 'lumber.framing',
        depth: 1,
        sort_order: 1,
        product_count: 1,
        children: [],
      },
    ],
  },
];

const DEALER = 'Kelly-Fradet';

/** The real 409 envelope, so a refusal is tested against what `gable` sends. */
function refusal(code: string, reason: string): GableHttpError {
  return new GableHttpError(409, 'The supplier refused (HTTP 409).', 'Conflict', { code, reason });
}

interface Stub {
  client: GableClient;
  calls: string[];
}

function stubClient(overrides: Partial<GableClient> = {}): Stub {
  const calls: string[] = [];

  const emptyCart = {
    id: 'cart-1',
    items: [] as never[],
    item_count: 0,
    subtotal: 0,
  };

  const base = {
    login: vi.fn(),
    logout: vi.fn(),
    config: vi.fn(),
    dashboard: vi.fn(),
    catalog: vi.fn(async () => [PRODUCT]),
    catalogProduct: vi.fn(),
    categories: vi.fn(async () => TREE),
    volumeBreaks: vi.fn(async () => []),
    cart: vi.fn(async () => emptyCart),
    addCartItem: vi.fn(async () => emptyCart),
    updateCartItem: vi.fn(),
    removeCartItem: vi.fn(async () => emptyCart),
    checkout: vi.fn(async (request: { project_id?: string | undefined }) => {
      calls.push(`checkout:${request.project_id ?? 'none'}`);
      return { order_id: PLACED_ORDER.id, message: 'ok' };
    }),
    orders: vi.fn(async () => [PLACED_ORDER]),
    orderFeed: vi.fn(async () => ({
      orders: [PLACED_ORDER],
      etag: '"v1"',
      latestChange: '2026-08-24T17:30:00Z',
    })),
    order: vi.fn(async () => PLACED_ORDER),
    cancelOrder: vi.fn(async (id: string) => {
      calls.push(`cancel:${id}`);
      return {
        order_id: id,
        status: 'CANCELLED',
        previous_status: 'CONFIRMED',
        message: 'Order cancelled',
      };
    }),
    setOrderProject: vi.fn(async () => PLACED_ORDER),
    deliveries: vi.fn(async () => {
      calls.push('deliveries');
      return [];
    }),
    requestReschedule: vi.fn(),
    reschedule: vi.fn(async () => null),
    quotes: vi.fn(async () => []),
    quote: vi.fn(),
    createQuote: vi.fn(),
    acceptQuote: vi.fn(),
    declineQuote: vi.fn(),
    projects: vi.fn(async () => []),
    ...overrides,
  } as unknown as GableClient;

  return { client: base, calls };
}

/** Boot, then swap in the ERP catalog + pricing + supplier, as `connect.ts` does. */
function wire(client: GableClient) {
  boot({ reset: true });
  ordersStore.set(emptyCollection());
  scopeStore.set(emptyCollection());
  quotesStore.set(emptyCollection());
  salesOrdersStore.set(emptyCollection());
  installSupplier({
    supplier: createGableSupplier({
      client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
    }),
    pricing: createGablePricingEngine([PRODUCT], {
      loadVolumeBreaks: (productId) => client.volumeBreaks(productId),
    }),
    catalog: catalogStateFrom([PRODUCT], DEALER, TREE),
  });
  getContext().sim.scheduler.stop();
}

function plannedOrder(): string {
  const project = listOf(projectsStore.get())[0];
  if (!project) throw new Error('expected the boot scenario to have left a project');
  const order = createOrder({
    projectId: project.id,
    name: 'Framing package',
    requestedDate: addDays(getContext().clock.nowIso(), 7),
  });
  if (!order.ok) throw new Error(order.error);
  const added = addCatalogItem({ orderId: order.value.id, product: PRODUCT.sku, qty: 40 });
  if (!added.ok) throw new Error(added.error);
  return order.value.id;
}

/** A board order already placed with the ERP, so cancel/reschedule have a target. */
async function placedOrder(stub: Stub): Promise<string> {
  const orderId = plannedOrder();
  moveOrderToStage(orderId, 'order');
  await vi.waitFor(() =>
    expect(ordersStore.get().byId[orderId]?.salesOrderId).toBe(`gso_${PLACED_ORDER.id}`),
  );
  stub.calls.length = 0;
  return orderId;
}

const quoteDto = (over: Partial<GableQuote> = {}): GableQuote => ({
  id: 'q-erp-1',
  status: 'REQUESTED',
  erp_state: 'DRAFT',
  project_id: null,
  project_name: null,
  notes: 'Framing package',
  priced: false,
  total_amount: 0,
  freight_amount: 0,
  delivery_type: 'DELIVERY',
  expires_at: null,
  sent_at: null,
  accepted_at: null,
  rejected_at: null,
  created_at: '2026-08-24T17:00:00Z',
  updated_at: '2026-08-24T17:00:00Z',
  lines: [],
  ...over,
});

beforeEach(() => {
  resetGableState();
});

// --- 1. Quotes ----------------------------------------------------------

describe('1. the quote desk is real now', () => {
  it('sends the order’s scope and replaces the local record with the dealer’s quote', async () => {
    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    const moved = moveOrderToStage(orderId, 'quote');
    expect(moved.ok).toBe(true);

    await vi.waitFor(() => {
      const quote = listOf(quotesStore.get())[0];
      expect(quote?.supplierRef).toBe('q-erp-1');
    });

    const quote = listOf(quotesStore.get())[0];
    // A dealer-facing number derived from the dealer's id, not a minted
    // LOCAL-xxxx that nobody at the yard could look up.
    expect(quote?.number).toBe('GQ-q-erp-1');
    expect(quote?.status).toBe('submitted');
    expect(quote?.supplierState).toBe('REQUESTED');
    // No expiry on an unpriced request: an expiry implies a held price.
    expect(quote?.expiresAt).toBeUndefined();

    const sent = vi.mocked(stub.client.createQuote).mock.calls[0]?.[0];
    expect(sent?.lines).toHaveLength(1);
    expect(sent?.lines[0]?.product_id).toBe(PRODUCT.id);
    expect(sent?.lines[0]?.quantity).toBe(40);
  });

  it('sends a SPECIAL-ORDER line, which had no way to leave this browser before', async () => {
    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
    });
    wire(stub.client);

    const project = listOf(projectsStore.get())[0];
    if (!project) throw new Error('no project');
    const order = createOrder({
      projectId: project.id,
      name: 'Custom door',
      requestedDate: addDays(getContext().clock.nowIso(), 30),
    });
    if (!order.ok) throw new Error(order.error);
    const added = addSpecialItem({
      orderId: order.value.id,
      description: 'Custom 36" fir door, left hand',
      qty: 1,
    });
    if (!added.ok) throw new Error(added.error);

    moveOrderToStage(order.value.id, 'quote');

    await vi.waitFor(() => expect(stub.client.createQuote).toHaveBeenCalled());
    const sent = vi.mocked(stub.client.createQuote).mock.calls[0]?.[0];
    // `gable`'s quote line takes a null product id plus a description and a
    // uom. That is the entire reason a custom door can now be priced by a
    // person instead of being refused at the cart.
    expect(sent?.lines[0]?.product_id).toBeUndefined();
    expect(sent?.lines[0]?.description).toBe('Custom 36" fir door, left hand');
    expect(sent?.lines[0]?.uom).toBeTruthy();
  });

  it('walks the card back to Plan when the dealer refuses the request', async () => {
    const stub = stubClient({
      createQuote: vi.fn(() =>
        Promise.reject(new GableHttpError(500, 'The supplier refused POST /quotes (HTTP 500).')),
      ) as GableClient['createQuote'],
    });
    wire(stub.client);
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'quote');
    await vi.waitFor(() => expect(ordersStore.get().byId[orderId]?.stage).toBe('plan'));

    // A card in Quote whose scope nobody received is the same lie as a card in
    // Order with no order behind it.
    expect(ordersStore.get().byId[orderId]?.quoteId).toBeUndefined();
    expect(listOf(quotesStore.get())).toHaveLength(0);
  });

  it('refuses 409 QUOTE_NOT_PRICED with the dealer’s own sentence, and changes nothing', async () => {
    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
      acceptQuote: vi.fn(() =>
        Promise.reject(
          refusal(
            'QUOTE_NOT_PRICED',
            'This quote has not been priced and sent by the dealer yet, or it has already been closed.',
          ),
        ),
      ) as GableClient['acceptQuote'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'quote');
    await vi.waitFor(() => expect(listOf(quotesStore.get())[0]?.supplierRef).toBe('q-erp-1'));

    const result = await acceptSupplierQuote(orderId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('has not been priced');
    // The refusal did not silently mark anything accepted, and did not put a
    // price on a line.
    expect(listOf(quotesStore.get())[0]?.status).toBe('submitted');
    expect(listOf(scopeStore.get())[0]?.priceSource).not.toBe('quoted');
  });

  it('writes the dealer’s prices onto the scope when the quote is accepted', async () => {
    const currentScopeItemProduct = PRODUCT.id;
    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
      acceptQuote: vi.fn(async () =>
        quoteDto({
          status: 'ACCEPTED',
          erp_state: 'ACCEPTED',
          priced: true,
          total_amount: 220,
          expires_at: '2026-09-10T00:00:00Z',
          lines: [
            {
              id: 'ql-1',
              product_id: currentScopeItemProduct,
              product_sku: PRODUCT.sku,
              description: PRODUCT.name,
              customer_note: '',
              quantity: 40,
              uom: 'EA',
              unit_price: 5.5,
              line_total: 220,
              is_special_order: false,
            },
          ],
        }),
      ) as GableClient['acceptQuote'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'quote');
    await vi.waitFor(() => expect(listOf(quotesStore.get())[0]?.supplierRef).toBe('q-erp-1'));

    const result = await acceptSupplierQuote(orderId);

    expect(result.ok).toBe(true);
    const item = listOf(scopeStore.get())[0];
    // 5.50 float dollars -> 550 integer cents, through the one boundary that
    // is allowed to change units.
    expect(item?.unitPrice).toBe(550);
    expect(item?.priceSource).toBe('quoted');
    expect(item?.priceExpiresAt).toBe('2026-09-10T00:00:00Z');
    void currentScopeItemProduct;
  });

  it('REFUSES to apply prices when the dealer’s lines no longer match the scope', async () => {
    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
      acceptQuote: vi.fn(async () =>
        quoteDto({
          status: 'ACCEPTED',
          priced: true,
          lines: [
            {
              id: 'ql-1',
              // A DIFFERENT product from the one on this order.
              product_id: 'some-other-product',
              product_sku: 'OTHER',
              description: 'Something else',
              customer_note: '',
              quantity: 40,
              uom: 'EA',
              unit_price: 99,
              line_total: 3960,
              is_special_order: false,
            },
          ],
        }),
      ) as GableClient['acceptQuote'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'quote');
    await vi.waitFor(() => expect(listOf(quotesStore.get())[0]?.supplierRef).toBe('q-erp-1'));

    const before = listOf(scopeStore.get())[0]?.unitPrice;
    await acceptSupplierQuote(orderId);

    // Nothing written. Putting one product's price on another product's line
    // is invisible to a contractor; an unpriced order is not.
    expect(listOf(scopeStore.get())[0]?.unitPrice).toBe(before);
    expect(listOf(scopeStore.get())[0]?.unitPrice).not.toBe(9900);
  });

  it('reads a dealer’s pricing back on the next poll, without anyone pressing anything', async () => {
    const priced = quoteDto({
      status: 'PRICED',
      erp_state: 'SENT',
      priced: true,
      total_amount: 240,
      sent_at: '2026-08-25T09:00:00Z',
      lines: [
        {
          id: 'ql-1',
          product_id: PRODUCT.id,
          product_sku: PRODUCT.sku,
          description: PRODUCT.name,
          customer_note: '',
          quantity: 40,
          uom: 'EA',
          unit_price: 6,
          line_total: 240,
          is_special_order: false,
        },
      ],
    });

    const stub = stubClient({
      createQuote: vi.fn(async () => quoteDto()) as GableClient['createQuote'],
      quotes: vi.fn(async () => [priced]) as GableClient['quotes'],
    });
    wire(stub.client);
    const orderId = plannedOrder();
    moveOrderToStage(orderId, 'quote');
    await vi.waitFor(() => expect(listOf(quotesStore.get())[0]?.supplierRef).toBe('q-erp-1'));

    const changed = await syncQuotes({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
    });

    expect(changed).toBe(1);
    expect(listOf(quotesStore.get())[0]?.status).toBe('priced');
    expect(listOf(scopeStore.get())[0]?.unitPrice).toBe(600);
    // Without this the quote column would be a one-way outbox.
    expect(activityStore.get().entries.some((entry) => entry.kind === 'quote.priced')).toBe(true);
  });

  it('never polls quotes it did not send — a dealer quote with no card is theirs', async () => {
    const stub = stubClient({ quotes: vi.fn(async () => [quoteDto()]) as GableClient['quotes'] });
    wire(stub.client);

    const changed = await syncQuotes({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
    });

    expect(changed).toBe(0);
    expect(stub.client.quotes).not.toHaveBeenCalled();
  });
});

// --- 2. project_id ------------------------------------------------------

describe('2. an order knows which job it is for', () => {
  it('files a new order against its project at checkout', async () => {
    const stub = stubClient();
    wire(stub.client);
    const project = listOf(projectsStore.get())[0];
    const orderId = plannedOrder();

    moveOrderToStage(orderId, 'order');
    await vi.waitFor(() => expect(stub.calls.some((c) => c.startsWith('checkout:'))).toBe(true));

    // Not 'none'. `gable` verifies the project belongs to the customer and
    // refuses checkout otherwise, so this is a checked association rather than
    // a hint.
    expect(stub.calls).toContain(`checkout:${project?.id}`);
  });

  it('lands the dealer’s existing order history on the job THEY filed it against', async () => {
    const stub = stubClient({
      orderFeed: vi.fn(async (query: { projectId?: string | undefined }) => ({
        orders:
          query.projectId === 'prj-wilson' ? [{ ...PLACED_ORDER, project_id: 'prj-wilson' }] : [],
        etag: undefined,
        latestChange: undefined,
      })) as GableClient['orderFeed'],
      orders: vi.fn(async () => []) as GableClient['orders'],
    });
    wire(stub.client);

    const history = await adoptOrderHistory({
      client: stub.client,
      projects: [
        {
          id: 'prj-wilson',
          accountId: 'cust-1',
          name: 'Wilson House',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      products: catalogStore.get().products,
      dealerName: DEALER,
      now: getContext().clock.nowIso(),
    });

    expect(history.orders).toHaveLength(1);
    expect(history.orders[0]?.id).toBe(boardOrderIdFor(PLACED_ORDER.id));
    expect(history.orders[0]?.projectId).toBe('prj-wilson');
    // Lines become scope, at what the dealer charged.
    expect(history.items).toHaveLength(1);
    expect(history.items[0]?.unitPrice).toBe(495);
    expect(history.items[0]?.priceSource).toBe('erp');
    // The stage is `order`, never `invoice`: the portal's Invoice stage means
    // a portal-side invoice record exists, and the order feed carries none.
    expect(history.orders[0]?.stage).toBe('order');
  });

  it('does not invent a job for an order the dealer filed against none', async () => {
    const stub = stubClient({
      orderFeed: vi.fn(async () => ({
        orders: [],
        etag: undefined,
        latestChange: undefined,
      })) as GableClient['orderFeed'],
      orders: vi.fn(async () => [{ ...PLACED_ORDER, project_id: null }]) as GableClient['orders'],
    });
    wire(stub.client);

    const history = await adoptOrderHistory({
      client: stub.client,
      projects: [
        {
          id: 'prj-wilson',
          accountId: 'cust-1',
          name: 'Wilson House',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      products: catalogStore.get().products,
      dealerName: DEALER,
      now: getContext().clock.nowIso(),
    });

    // Held, not filed. Which job an order was for is the contractor's
    // knowledge; guessing would put another site's materials on this one.
    expect(history.orders).toHaveLength(0);
    expect(history.unassigned).toHaveLength(1);
  });

  it('attaches an unfiled order through the supplier, not by editing the board', async () => {
    const stub = stubClient();
    wire(stub.client);

    const attached = await getContext().supplier.attachOrderToProject(PLACED_ORDER.id, 'prj-1');

    expect(attached.ok).toBe(true);
    expect(stub.client.setOrderProject).toHaveBeenCalledWith(PLACED_ORDER.id, 'prj-1');
  });
});

// --- 3. Cancellation ----------------------------------------------------

describe('3. cancellation reaches the ERP, and its refusals are respected', () => {
  it('cancels for real and records what it changed from', async () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = await placedOrder(stub);

    moveOrderToStage(orderId, 'plan');
    await vi.waitFor(() =>
      expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('cancelled'),
    );

    expect(stub.calls).toContain(`cancel:${PLACED_ORDER.id}`);
    const tracking = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.tracking ?? [];
    expect(tracking.at(-1)?.note).toContain('CONFIRMED');
  });

  it('refuses a SECOND cancel with ORDER_ALREADY_CANCELLED and puts the card back', async () => {
    const stub = stubClient({
      cancelOrder: vi.fn(() =>
        Promise.reject(
          refusal('ORDER_ALREADY_CANCELLED', 'This order has already been cancelled.'),
        ),
      ) as GableClient['cancelOrder'],
    });
    wire(stub.client);
    const orderId = await placedOrder(stub);

    moveOrderToStage(orderId, 'plan');
    await vi.waitFor(() =>
      expect(
        activityStore.get().entries.some((entry) => entry.kind === 'order.cancel-refused'),
      ).toBe(true),
    );

    // Back in Order. Leaving it in Plan would show a contractor an order they
    // believe they killed.
    expect(ordersStore.get().byId[orderId]?.stage).toBe('order');
    expect(
      activityStore.get().entries.find((entry) => entry.kind === 'order.cancel-refused')?.message,
    ).toContain('already been cancelled');
  });

  it('refuses a FULFILLED order with ORDER_NOT_CANCELLABLE and says to ask for a credit', async () => {
    const stub = stubClient({
      cancelOrder: vi.fn(() =>
        Promise.reject(
          refusal(
            'ORDER_NOT_CANCELLABLE',
            'A fulfilled order cannot be cancelled. Ask the dealer for a credit.',
          ),
        ),
      ) as GableClient['cancelOrder'],
    });
    wire(stub.client);
    const orderId = await placedOrder(stub);

    moveOrderToStage(orderId, 'plan');
    await vi.waitFor(() =>
      expect(
        activityStore.get().entries.some((entry) => entry.kind === 'order.cancel-refused'),
      ).toBe(true),
    );

    const salesOrder = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`];
    // Status UNCHANGED. `cancelled` here would assert something about the ERP
    // that is not true.
    expect(salesOrder?.status).toBe('confirmed');
    expect(salesOrder?.tracking.at(-1)?.note).toContain('credit');
  });

  it('treats a 500 like any other refusal: order untouched, card back in Order', async () => {
    /**
     * Not hypothetical. Against a live `gable` on the seeded database,
     * cancelling a CONFIRMED order answers 500 — `order.CancelOrder` releases
     * the allocation for every line and `inventory.Release` errors with "no
     * allocated stock found" when the seeded order never held one. That is a
     * defect on the `gable` side and is reported rather than worked around
     * here; what this asserts is that the portal's response to it is safe.
     *
     * The dangerous alternative would be treating an unrecognised failure as
     * "probably cancelled" and flipping the card. A 500 means the ERP does not
     * know what happened, which is the strongest possible reason not to claim
     * on a contractor's board that it did.
     */
    const stub = stubClient({
      cancelOrder: vi.fn(() =>
        Promise.reject(
          new GableHttpError(500, 'The supplier refused POST /orders/x/cancel (HTTP 500).'),
        ),
      ) as GableClient['cancelOrder'],
    });
    wire(stub.client);
    const orderId = await placedOrder(stub);

    moveOrderToStage(orderId, 'plan');
    await vi.waitFor(() =>
      expect(
        activityStore.get().entries.some((entry) => entry.kind === 'order.cancel-refused'),
      ).toBe(true),
    );

    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('confirmed');
    expect(ordersStore.get().byId[orderId]?.stage).toBe('order');
  });

  it('refuses goods on a dispatched route with ORDER_IN_MOTION', async () => {
    const stub = stubClient({
      cancelOrder: vi.fn(() =>
        Promise.reject(
          refusal(
            'ORDER_IN_MOTION',
            "This order's goods are already on a dispatched route or delivered. Call the dealer.",
          ),
        ),
      ) as GableClient['cancelOrder'],
    });
    wire(stub.client);
    const orderId = await placedOrder(stub);

    moveOrderToStage(orderId, 'plan');
    await vi.waitFor(() =>
      expect(
        activityStore.get().entries.some((entry) => entry.kind === 'order.cancel-refused'),
      ).toBe(true),
    );

    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.status).toBe('confirmed');
    expect(ordersStore.get().byId[orderId]?.stage).toBe('order');
  });
});

// --- 4. Reschedule ------------------------------------------------------

describe('4. a reschedule is requested, never confirmed', () => {
  const PENDING: GableReschedule = {
    id: 'rr-1',
    delivery_id: 'del-1',
    order_id: PLACED_ORDER.id,
    requested_date: '2026-09-04',
    reason: 'Requested from the contractor portal',
    status: 'PENDING',
    applied: false,
    current_scheduled_date: '2026-08-28',
    resolution_note: null,
    created_at: '2026-08-24T17:00:00Z',
    updated_at: '2026-08-24T17:00:00Z',
  };

  function withDelivery(overrides: Partial<GableClient> = {}) {
    return stubClient({
      deliveries: vi.fn(async () => [
        {
          id: 'del-1',
          order_id: PLACED_ORDER.id,
          status: 'PENDING',
          created_at: '2026-08-24T17:00:00Z',
        },
      ]) as GableClient['deliveries'],
      requestReschedule: vi.fn(async () => PENDING) as GableClient['requestReschedule'],
      ...overrides,
    });
  }

  it('reports applied:false and does NOT move the promised date', async () => {
    const stub = withDelivery();
    wire(stub.client);
    const orderId = await placedOrder(stub);

    const before = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.promisedDate;
    const result = await requestDeliveryReschedule(
      orderId,
      addDays(getContext().clock.nowIso(), 11),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect(result.value.status).toBe('PENDING');
    // The dealer's board is the source of the date, and it has not moved.
    expect(result.value.currentScheduledDate).toBe('2026-08-28');
    expect(salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.promisedDate).toBe(before);
  });

  it('says "requested", and never says "moved"', async () => {
    const stub = withDelivery();
    wire(stub.client);
    const orderId = await placedOrder(stub);

    const result = await requestDeliveryReschedule(
      orderId,
      addDays(getContext().clock.nowIso(), 11),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A contractor who reads "moved to Friday" books a crew. The whole
    // capability turns on this sentence. ("Nothing has moved" is the sentence
    // that is allowed to contain the word.)
    expect(result.value.message).toMatch(/Requested/i);
    expect(result.value.message).not.toMatch(/moved to/i);
    expect(result.value.message).toMatch(/Nothing has moved/i);

    const note = salesOrdersStore.get().byId[`gso_${PLACED_ORDER.id}`]?.tracking.at(-1)?.note ?? '';
    expect(note).toContain('Asked');
    expect(note).toContain('dispatcher');
  });

  it('sends a calendar day, not the noon-anchored instant the date picker produces', async () => {
    const stub = withDelivery();
    wire(stub.client);
    const orderId = await placedOrder(stub);

    await requestDeliveryReschedule(orderId, '2026-09-04T12:00:00.000Z');

    expect(stub.client.requestReschedule).toHaveBeenCalledWith(
      'del-1',
      expect.objectContaining({ requested_date: '2026-09-04' }),
    );
  });

  it('refuses when the dealer has not scheduled a delivery at all', async () => {
    const stub = stubClient(); // deliveries: []
    wire(stub.client);
    const orderId = await placedOrder(stub);

    const result = await requestDeliveryReschedule(
      orderId,
      addDays(getContext().clock.nowIso(), 11),
    );

    expect(result.ok).toBe(false);
    // "There is no date to move" is a different answer from "we cannot move
    // it", and the contractor can act on the difference.
    if (!result.ok) expect(result.error).toContain('not scheduled a delivery');
  });

  it('passes DELIVERY_COMMITTED straight through as the dealer wrote it', async () => {
    const stub = withDelivery({
      requestReschedule: vi.fn(() =>
        Promise.reject(
          refusal(
            'DELIVERY_COMMITTED',
            'This delivery can no longer be rescheduled from the portal — the load is already on a truck or the stop is complete. Call the dealer.',
          ),
        ),
      ) as GableClient['requestReschedule'],
    });
    wire(stub.client);
    const orderId = await placedOrder(stub);

    const result = await requestDeliveryReschedule(
      orderId,
      addDays(getContext().clock.nowIso(), 11),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already on a truck');
  });
});

// --- 5. Lead time -------------------------------------------------------

describe('5. lead time: null and zero are different answers', () => {
  it('keeps a published zero and an unpublished null apart on the product', () => {
    expect(productFrom({ ...PRODUCT, lead_time_days: 0 }).leadTimeDays).toBe(0);
    expect(productFrom({ ...PRODUCT, lead_time_days: null }).leadTimeDays).toBeUndefined();
  });

  it('goes SILENT on the lead-time-vs-date warning when nobody published one', () => {
    const stub = stubClient({
      catalog: vi.fn(async () => [{ ...PRODUCT, lead_time_days: null }]) as GableClient['catalog'],
    });
    wire(stub.client);
    installSupplier({
      supplier: getContext().supplier,
      pricing: createGablePricingEngine([{ ...PRODUCT, lead_time_days: null }]),
      catalog: catalogStateFrom([{ ...PRODUCT, lead_time_days: null }], DEALER, TREE),
    });

    const orderId = plannedOrder();
    const order = ordersStore.get().byId[orderId];
    const project = projectsStore.get().byId[String(order?.projectId)];
    if (!order || !project) throw new Error('expected an order on a project');

    const detail = buildOrderDetail({
      order: { ...order, requestedDate: addDays(getContext().clock.nowIso(), 1) },
      project,
      items: listOf(scopeStore.get()).filter((item) => item.orderId === orderId),
      products: catalogStore.get().products,
      quoteFor: (product, qty) =>
        getContext().pricing.quote(product, qty, {
          accountId: project.accountId,
          tierId: 'tier_pro',
        }),
      now: getContext().clock.nowIso(),
    });

    expect(detail.lines[0]?.leadTimeDays).toBeUndefined();
    // Not "arrives in time" — UNKNOWN. A warning computed from an assumed zero
    // is a warning about nothing, and a contractor acts on it.
    expect(detail.lines[0]?.lateForDate).toBe(false);
  });

  it('still warns when the dealer HAS published a lead time that cannot make the date', () => {
    const stub = stubClient();
    wire(stub.client); // PRODUCT publishes 3 days
    const orderId = plannedOrder();
    const order = ordersStore.get().byId[orderId];
    const project = projectsStore.get().byId[String(order?.projectId)];
    if (!order || !project) throw new Error('expected an order on a project');

    const detail = buildOrderDetail({
      order: { ...order, requestedDate: addDays(getContext().clock.nowIso(), 1) },
      project,
      items: listOf(scopeStore.get()).filter((item) => item.orderId === orderId),
      products: catalogStore.get().products,
      quoteFor: (product, qty) =>
        getContext().pricing.quote(product, qty, {
          accountId: project.accountId,
          tierId: 'tier_pro',
        }),
      now: getContext().clock.nowIso(),
    });

    expect(detail.lines[0]?.leadTimeDays).toBe(3);
    expect(detail.lines[0]?.lateForDate).toBe(true);
  });
});

// --- 6. Volume breaks ---------------------------------------------------

describe('6. volume breaks come from the dealer’s own waterfall', () => {
  it('shows no break until a ladder has actually been loaded', () => {
    const engine = createGablePricingEngine([PRODUCT]);
    const product = productFrom(PRODUCT);

    expect(engine.breaksFor(PRODUCT.sku)).toBeUndefined();
    expect(engine.quote(product, 10, { accountId: 'a', tierId: 't' }).nextBreak).toBeUndefined();
  });

  it('offers the next cheaper rung once the ERP has answered', async () => {
    const engine = createGablePricingEngine([PRODUCT], {
      loadVolumeBreaks: async () => [
        {
          min_quantity: 100,
          unit_price: 4.5,
          price_source: 'VOLUME',
          details: '',
          saves_per_unit: 0.45,
        },
        {
          min_quantity: 500,
          unit_price: 4.1,
          price_source: 'VOLUME',
          details: '',
          saves_per_unit: 0.85,
        },
      ],
    });
    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);

    const quote = engine.quote(productFrom(PRODUCT), 40, { accountId: 'a', tierId: 't' });
    expect(quote.nextBreak?.minQty).toBe(100);
    // 4.50 float dollars -> 450 integer cents.
    expect(quote.nextBreak?.unitPrice).toBe(450);
  });

  it('offers nothing when no rung actually beats this customer’s price', async () => {
    const engine = createGablePricingEngine([PRODUCT], {
      // A contract price can beat a volume rule at every quantity — `gable`
      // still returns the ladder. "Buy 100 more to pay the same" is worse than
      // silence.
      loadVolumeBreaks: async () => [
        {
          min_quantity: 100,
          unit_price: 4.95,
          price_source: 'VOLUME',
          details: '',
          saves_per_unit: 0,
        },
      ],
    });
    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);

    expect(
      engine.quote(productFrom(PRODUCT), 40, { accountId: 'a', tierId: 't' }).nextBreak,
    ).toBeUndefined();
    // And an empty-but-loaded ladder is distinguishable from an unloaded one.
    expect(engine.breaksFor(PRODUCT.sku)).toHaveLength(1);
  });

  it('asks the ERP once per SKU, not once per render', async () => {
    const load = vi.fn(async () => []);
    const engine = createGablePricingEngine([PRODUCT], { loadVolumeBreaks: load });

    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);
    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a FAILED load as "there are none"', async () => {
    let attempts = 0;
    const engine = createGablePricingEngine([PRODUCT], {
      loadVolumeBreaks: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network');
        return [
          {
            min_quantity: 100,
            unit_price: 4.5,
            price_source: 'VOLUME',
            details: '',
            saves_per_unit: 0.45,
          },
        ];
      },
    });

    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);
    // Still unknown, not "empty": caching the failure would turn "we could not
    // ask" into "the dealer says there are none" and never retry.
    expect(engine.breaksFor(PRODUCT.sku)).toBeUndefined();

    await engine.primeVolumeBreaks([{ id: PRODUCT.id, sku: PRODUCT.sku }]);
    expect(engine.breaksFor(PRODUCT.sku)).toHaveLength(1);
  });
});

// --- 7. Category tree ---------------------------------------------------

describe('7. browse uses the dealer’s real hierarchy', () => {
  it('builds a parented tree from the ERP, not a flat list of display strings', () => {
    const state = catalogStateFrom([PRODUCT], DEALER, TREE);

    const lumber = state.categories.find((category) => category.name === 'Lumber');
    const framing = state.categories.find((category) => category.name === 'Framing Lumber');
    expect(lumber?.parentId).toBeUndefined();
    expect(framing?.parentId).toBe(lumber?.id);

    // The product hangs off the LEAF, so clicking the root has to cascade.
    expect(state.products[0]?.categoryId).toBe(framing?.id);
    const branches = catalogTree(state.categories, state.products);
    expect(branches).toHaveLength(1);
    expect(branches[0]?.count).toBe(1);
  });

  it('keeps a product the ERP never linked browsable, in its own flat aisle', () => {
    const unlinked: GableCatalogProduct = {
      ...PRODUCT,
      id: 'p-2',
      sku: 'MISC-1',
      category: 'Miscellaneous',
      category_id: null,
    };
    const state = catalogStateFrom([PRODUCT, unlinked], DEALER, TREE);

    const misc = state.categories.find((category) => category.name === 'Miscellaneous');
    expect(misc).toBeDefined();
    expect(misc?.parentId).toBeUndefined();
    expect(state.products.find((product) => product.sku === 'MISC-1')?.categoryId).toBe(misc?.id);
  });

  it('falls back to flat aisles when the tree endpoint gives nothing', () => {
    // A tree failure must not make a catalog unbrowsable — `connect.ts`
    // swallows it and this is the shape that results.
    const state = catalogStateFrom([PRODUCT], DEALER, []);
    expect(state.categories).toHaveLength(1);
    expect(state.categories[0]?.parentId).toBeUndefined();
    expect(state.products[0]?.categoryId).toBe(state.categories[0]?.id);
  });
});

// --- 8. Change feed -----------------------------------------------------

describe('8. the poll is conditional', () => {
  it('does no work at all on a 304, and does not touch deliveries', async () => {
    const stub = stubClient({
      orderFeed: vi.fn(async () => ({
        orders: null,
        etag: '"v1"',
        latestChange: undefined,
      })) as GableClient['orderFeed'],
    });
    wire(stub.client);

    const result = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
      cursor: '2026-08-24T17:30:00Z',
      etag: '"v1"',
    });

    expect(result.notModified).toBe(true);
    expect(result.changed).toBe(0);
    // The saving is two round trips, not one: the delivery list was the other
    // half of every wasted poll.
    expect(stub.calls).not.toContain('deliveries');
    // And the cursor is NOT advanced past a timestamp the ERP never sent.
    expect(result.cursor).toBe('2026-08-24T17:30:00Z');
  });

  it('sends the cursor and validator it was given', async () => {
    const stub = stubClient();
    wire(stub.client);

    await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
      cursor: '2026-08-24T10:00:00Z',
      etag: '"v0"',
    });

    expect(stub.client.orderFeed).toHaveBeenCalledWith({
      since: '2026-08-24T10:00:00Z',
      ifNoneMatch: '"v0"',
    });
  });

  it('adopts the change and hands back the next cursor when something moved', async () => {
    const stub = stubClient();
    wire(stub.client);
    const orderId = await placedOrder(stub);
    void orderId;

    const result = await syncOrderStatus({
      client: stub.client,
      nowIso: () => getContext().clock.nowIso(),
      dealerName: DEALER,
    });

    expect(result.notModified).toBe(false);
    expect(result.cursor).toBe('2026-08-24T17:30:00Z');
    expect(result.etag).toBe('"v1"');
  });
});

// --- The simulator, unchanged and honest about it -----------------------

describe('the sim path keeps working and refuses what it cannot model', () => {
  beforeEach(() => boot({ reset: true }));

  it('is the default, and applies a reschedule for real', async () => {
    expect(getContext().supplier.kind).toBe('sim');
    expect(getContext().supplier.capabilities.reschedule).toBe('applies');
  });

  it('refuses a quote decision instead of inventing an acceptance ceremony', async () => {
    const project = listOf(projectsStore.get())[0];
    if (!project) throw new Error('no project');
    const created = createOrder({
      projectId: project.id,
      name: 'Sim order',
      requestedDate: addDays(getContext().clock.nowIso(), 7),
    });
    if (!created.ok) throw new Error(created.error);

    const accepted = await acceptSupplierQuote(created.value.id);
    const declined = await declineSupplierQuote(created.value.id);

    expect(accepted.ok).toBe(false);
    expect(declined.ok).toBe(false);
    // Not "not allowed" — the reason there is no such step.
    if (!accepted.ok) expect(accepted.error).toContain('no accept or decline step');
  });

  it('says there is no supplier-side order history to file', async () => {
    const result = await getContext().supplier.attachOrderToProject('whatever', 'prj-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('already belongs to a job');
  });
});
