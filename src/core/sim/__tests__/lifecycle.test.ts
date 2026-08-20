// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moveOrderToStage } from '../../actions/orders';
import { addSpecialItem } from '../../actions/scope';
import { boot, getContext } from '../../boot';
import { canMoveToStage } from '../../domain/stage';
import {
  activityStore,
  invoicesStore,
  ordersStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
  simStore,
} from '../../stores/root';
import { listOf } from '../../stores/store';

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

const MILLER_DECK = 'ord_miller_deck'; // has an unpriced special-order line
const MILLER_FRAME = 'ord_miller_frame'; // fully priced, can go straight to Order

function itemsOf(orderId: string) {
  return listOf(scopeStore.get()).filter((i) => i.orderId === orderId);
}

/**
 * Runs the world forward until nothing is pending, or the guard trips.
 *
 * Note this runs PAST a quote's 14-day expiry — that is the point of
 * `runSteps` below, which stops where a contractor would be looking.
 */
function runToIdle(maxSteps = 40): number {
  const { sim } = getContext();
  let steps = 0;
  while (sim.control.skipToNextEvent()) {
    if (++steps > maxSteps) throw new Error('sim did not settle');
  }
  return steps;
}

/**
 * The scenario seeds sales orders for cards that start past Plan, so tests must
 * find the one they created rather than assuming index 0.
 */
function salesOrderFor(orderId: string) {
  return listOf(salesOrdersStore.get()).find((so) => so.orderId === orderId);
}

/** Advances exactly n supplier events. */
function runSteps(n: number): void {
  const { sim } = getContext();
  for (let i = 0; i < n; i++) sim.control.skipToNextEvent();
}

/** Review, then price. Leaves the quote live rather than letting it lapse. */
function runUntilPriced(): void {
  runSteps(2);
}

describe('quote desk', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('creates a quote when an order is sent to the desk', () => {
    expect(moveOrderToStage(MILLER_DECK, 'quote').ok).toBe(true);

    const quotes = listOf(quotesStore.get());
    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.status).toBe('submitted');
    expect(ordersStore.get().byId[MILLER_DECK]?.quoteId).toBe(quotes[0]?.id);
  });

  it('does not answer instantly — a person is meant to be pricing it', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    getContext().sim.scheduler.pump();

    expect(listOf(quotesStore.get())[0]?.status).toBe('submitted');
  });

  it('prices the special-order line that blocked the order', () => {
    const before = itemsOf(MILLER_DECK).filter((i) => i.priceSource === 'unpriced');
    expect(before.length).toBeGreaterThan(0);

    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();

    const quote = listOf(quotesStore.get())[0];
    expect(quote?.status).toBe('priced');
    expect(quote?.deskNote).toBeTruthy();
    expect(quote?.linePrices.length).toBe(before.length);

    for (const item of itemsOf(MILLER_DECK)) {
      expect(item.priceSource).not.toBe('unpriced');
      expect(item.unitPrice).toBeGreaterThan(0);
    }
  });

  it('unblocks the order that could not previously be placed', () => {
    const order = ordersStore.get().byId[MILLER_DECK];
    if (!order) throw new Error('missing order');

    // Before: blocked by the unpriced special-order line.
    expect(
      canMoveToStage(order, 'order', {
        items: itemsOf(MILLER_DECK),
        now: getContext().clock.nowIso(),
      }).ok,
    ).toBe(false);

    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();

    const priced = ordersStore.get().byId[MILLER_DECK];
    if (!priced) throw new Error('missing order');
    expect(
      canMoveToStage(priced, 'order', {
        items: itemsOf(MILLER_DECK),
        now: getContext().clock.nowIso(),
      }).ok,
    ).toBe(true);
  });

  it('prices a door far above a bracket, so quotes read as plausible', () => {
    addSpecialItem({ orderId: MILLER_FRAME, description: 'Custom entry door 36x80', qty: 1 });
    addSpecialItem({ orderId: MILLER_FRAME, description: 'Custom steel bracket', qty: 4 });

    moveOrderToStage(MILLER_FRAME, 'quote');
    runUntilPriced();

    const items = itemsOf(MILLER_FRAME);
    const door = items.find((i) => i.snapshot.name.includes('door'));
    const bracket = items.find((i) => i.snapshot.name.includes('bracket'));

    expect(door?.unitPrice).toBeGreaterThan((bracket?.unitPrice ?? 0) * 5);
  });

  it('cancels pending desk work when the order is withdrawn', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    expect(getContext().sim.control.pendingCount()).toBeGreaterThan(0);

    moveOrderToStage(MILLER_DECK, 'plan');

    expect(listOf(quotesStore.get())[0]?.status).toBe('withdrawn');
    expect(getContext().sim.control.pendingCount()).toBe(0);
  });
});

describe('order lifecycle', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('creates a sales order when an order is placed', () => {
    expect(moveOrderToStage(MILLER_FRAME, 'order').ok).toBe(true);

    const so = salesOrderFor(MILLER_FRAME);
    expect(so?.status).toBe('submitted');
    expect(so?.number).toMatch(/^SO-\d+$/);
    expect(so?.subtotal).toBeGreaterThan(0);
  });

  it('walks all the way to delivered and invoiced', () => {
    moveOrderToStage(MILLER_FRAME, 'order');
    runToIdle();

    const so = salesOrderFor(MILLER_FRAME);
    expect(so?.status).toBe('invoiced');
    expect(so?.deliveredAt).toBeTruthy();

    // Every step left a trace the contractor can read.
    const statuses = so?.tracking.map((t) => t.status) ?? [];
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('picking');
    expect(statuses).toContain('out-for-delivery');
    expect(statuses).toContain('delivered');
  });

  it('never dispatches before the date the contractor asked for', () => {
    const order = ordersStore.get().byId[MILLER_FRAME];
    const requested = order?.requestedDate;
    if (!requested) throw new Error('expected a requested date');

    moveOrderToStage(MILLER_FRAME, 'order');
    runToIdle();

    const so = salesOrderFor(MILLER_FRAME);
    const dispatch = so?.tracking.find((t) => t.status === 'out-for-delivery');
    expect(dispatch).toBeTruthy();
    // A truck arriving a week early reads as broken, not fast.
    expect(new Date(dispatch?.at ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(requested).getTime() - 24 * 3600_000,
    );
  });

  it('moves the card into Invoice itself — the supplier bills, not the contractor', () => {
    moveOrderToStage(MILLER_FRAME, 'order');
    expect(ordersStore.get().byId[MILLER_FRAME]?.stage).toBe('order');

    runToIdle();

    expect(ordersStore.get().byId[MILLER_FRAME]?.stage).toBe('invoice');
    const invoice = listOf(invoicesStore.get())[0];
    expect(invoice?.number).toMatch(/^INV-\d+$/);
    expect(invoice?.balance).toBeGreaterThan(0);
  });

  it('parks a will-call order at ready-for-pickup instead of faking collection', () => {
    // Kirkland is seeded as will-call; reset it to Plan then place it.
    const willCall = 'ord_kirkland';
    boot({ reset: true, seed: 20_260_730 });

    const order = ordersStore.get().byId[willCall];
    expect(order?.fulfillment).toBe('willcall');
  });

  it('stops supplier work when the order is cancelled', () => {
    moveOrderToStage(MILLER_FRAME, 'order');
    getContext().sim.control.skipToNextEvent(); // confirmed

    moveOrderToStage(MILLER_FRAME, 'plan');

    expect(salesOrderFor(MILLER_FRAME)?.status).toBe('cancelled');
    expect(getContext().sim.control.pendingCount()).toBe(0);
  });
});

describe('the world keeps turning', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('records supplier events as unread activity', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();

    const entries = activityStore.get().entries;
    expect(entries.some((e) => e.actor === 'system' && e.kind === 'quote.priced')).toBe(true);
    expect(entries.some((e) => e.actor === 'user' && e.kind === 'quote.submitted')).toBe(true);
  });

  it('persists pending work so it survives a reload', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    expect(simStore.get().tasks.length).toBeGreaterThan(0);

    const pending = simStore.get().tasks.map((t) => t.type);
    expect(pending).toContain('quote.review');
  });

  it('replays identically from the same seed', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    const first = itemsOf(MILLER_DECK).map((i) => i.unitPrice);

    boot({ reset: true, seed: 20_260_730 });
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    const second = itemsOf(MILLER_DECK).map((i) => i.unitPrice);

    expect(second).toEqual(first);
  });

  it('produces different quotes under a different seed', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    const first = itemsOf(MILLER_DECK).map((i) => i.unitPrice);

    boot({ reset: true, seed: 777 });
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    const second = itemsOf(MILLER_DECK).map((i) => i.unitPrice);

    expect(second).not.toEqual(first);
  });

  it('settles rather than scheduling forever', () => {
    moveOrderToStage(MILLER_FRAME, 'order');
    const steps = runToIdle();

    expect(steps).toBeGreaterThan(3);
    expect(getContext().sim.control.pendingCount()).toBe(0);
    expect(getContext().sim.control.nextDueAt()).toBeNull();
  });
});

describe('supplier pricing expires', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('stamps an expiry on every desk-quoted line', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();

    const quoted = itemsOf(MILLER_DECK).filter((i) => i.priceSource === 'quoted');
    expect(quoted.length).toBeGreaterThan(0);
    for (const item of quoted) {
      expect(item.priceExpiresAt).toBeTruthy();
      expect(new Date(item.priceExpiresAt as string).getTime()).toBeGreaterThan(
        new Date(getContext().clock.nowIso()).getTime(),
      );
    }
  });

  it('re-blocks the order once the dealer stops standing behind the price', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    moveOrderToStage(MILLER_DECK, 'plan');

    const before = ordersStore.get().byId[MILLER_DECK];
    if (!before) throw new Error('missing order');
    expect(
      canMoveToStage(before, 'order', {
        items: itemsOf(MILLER_DECK),
        now: getContext().clock.nowIso(),
      }).ok,
    ).toBe(true);

    // Walk past the 14-day validity.
    getContext().sim.control.advanceDays(20);

    const after = ordersStore.get().byId[MILLER_DECK];
    if (!after) throw new Error('missing order');
    const decision = canMoveToStage(after, 'order', {
      items: itemsOf(MILLER_DECK),
      now: getContext().clock.nowIso(),
    });

    expect(decision.ok).toBe(false);
    // The wording distinguishes 'lapsed' from 'never priced' — they feel
    // completely different to a contractor.
    if (!decision.ok) expect(decision.error).toContain('expired');
  });

  it('marks the quote expired and says so in activity', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    getContext().sim.control.advanceDays(20);

    expect(listOf(quotesStore.get())[0]?.status).toBe('expired');
    expect(activityStore.get().entries.some((e) => e.kind === 'quote.expired')).toBe(true);
  });

  it('does not expire pricing that is already locked into a placed order', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    runUntilPriced();
    moveOrderToStage(MILLER_DECK, 'order');

    getContext().sim.control.advanceDays(30);

    // The sales order carries the agreed price; a lapsing quote cannot unwind it.
    expect(listOf(quotesStore.get())[0]?.status).not.toBe('expired');
    expect(ordersStore.get().byId[MILLER_DECK]?.stage).not.toBe('plan');
  });
});
