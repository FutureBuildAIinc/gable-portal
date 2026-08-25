// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot, getContext } from '../../boot';
import { SALES_ORDER_FLOW } from '../../domain/supplier';
import { addDays } from '../../lib/time';
import { trackingForOrder } from '../../selectors/tracking';
import { ordersStore, salesOrdersStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import {
  confirmWillCallPickup,
  requestDeliveryReschedule,
  updateSiteInstructions,
} from '../fulfillment';
import { moveOrderToStage, updateOrder } from '../orders';

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

const FRAME = 'ord_miller_frame'; // fully priced, so it can go straight to Order

/** Advances exactly n supplier events. */
function runSteps(n: number): void {
  const { sim } = getContext();
  for (let i = 0; i < n; i++) sim.control.skipToNextEvent();
}

function runToIdle(maxSteps = 40): void {
  const { sim } = getContext();
  let steps = 0;
  while (sim.control.skipToNextEvent()) {
    if (++steps > maxSteps) throw new Error('sim did not settle');
  }
}

function place(fulfillment: 'delivery' | 'willcall' = 'delivery') {
  updateOrder(FRAME, { fulfillment });
  const result = moveOrderToStage(FRAME, 'order');
  if (!result.ok) throw new Error(result.error);
}

function salesOrder() {
  // The scenario seeds sales orders for cards that start past Plan, so look up
  // the one this test placed rather than assuming index 0.
  const so = listOf(salesOrdersStore.get()).find((candidate) => candidate.orderId === FRAME);
  if (!so) throw new Error('expected a sales order');
  return so;
}

function tracking(now?: string) {
  const result = trackingForOrder(FRAME, now ?? getContext().clock.nowIso());
  if (!result) throw new Error('expected tracking');
  return result;
}

function stateOf(status: string): string | undefined {
  return tracking().steps.find((step) => step.status === status)?.state;
}

describe('timeline steps', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('has nothing to show until the order is actually placed', () => {
    expect(trackingForOrder(FRAME, getContext().clock.nowIso())).toBeNull();
  });

  it('lays out the whole journey, not just what has already happened', () => {
    place();

    const steps = tracking().steps;
    expect(steps.map((step) => step.status)).toEqual([...SALES_ORDER_FLOW]);
    // Everything past the current step is still promised, which is the half a
    // completed-events log cannot answer.
    expect(steps.filter((step) => step.state === 'upcoming')).toHaveLength(
      SALES_ORDER_FLOW.length - 1,
    );
  });

  it('marks exactly one step current, and everything before it done', () => {
    place();
    expect(stateOf('submitted')).toBe('current');

    runSteps(1); // confirmed
    expect(stateOf('submitted')).toBe('done');
    expect(stateOf('confirmed')).toBe('current');
    expect(stateOf('picking')).toBe('upcoming');

    expect(tracking().steps.filter((step) => step.state === 'current')).toHaveLength(1);
  });

  it("carries the supplier's own timestamp and wording onto each reached step", () => {
    place();
    runSteps(1);

    const confirmed = tracking().steps.find((step) => step.status === 'confirmed');
    const event = salesOrder().tracking.find((entry) => entry.status === 'confirmed');
    expect(confirmed?.at).toBe(event?.at);
    expect(confirmed?.note).toBe(event?.note);

    // Nothing invents a timestamp for something that hasn't happened.
    expect(tracking().steps.find((step) => step.status === 'delivered')?.at).toBeUndefined();
  });

  it('flags an order that has blown through its promised date', () => {
    place();
    runSteps(2); // picking — nowhere near delivered

    expect(tracking().late).toBe(false);
    expect(tracking(addDays(getContext().clock.nowIso(), 30)).late).toBe(true);
  });

  it('stops flagging late once it has arrived', () => {
    place();
    runToIdle();

    expect(tracking(addDays(getContext().clock.nowIso(), 30)).late).toBe(false);
  });
});

describe('will-call and delivery track differently', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('routes a delivery through the truck', () => {
    place('delivery');

    const statuses = tracking().steps.map((step) => step.status);
    expect(statuses).toContain('out-for-delivery');
    expect(statuses).not.toContain('ready-willcall');
    expect(tracking().willCall).toBe(false);
  });

  it('swaps the truck step for the counter on a will-call', () => {
    place('willcall');

    const statuses = tracking().steps.map((step) => step.status);
    expect(statuses).toContain('ready-willcall');
    expect(statuses).not.toContain('out-for-delivery');
    expect(tracking().willCall).toBe(true);
    // Same journey, one substitution — not a second, shorter flow.
    expect(statuses).toHaveLength(SALES_ORDER_FLOW.length);
  });

  it('lights up the counter step when the yard says it is ready', () => {
    place('willcall');
    runSteps(3); // confirm, pick, staged -> ready at the counter

    expect(salesOrder().status).toBe('ready-willcall');
    expect(stateOf('ready-willcall')).toBe('current');
    expect(stateOf('picking')).toBe('done');
    expect(tracking().canConfirmPickup).toBe(true);
  });
});

describe('rescheduling', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('moves the promised date and says so on the timeline', async () => {
    place();
    const wanted = addDays(getContext().clock.nowIso(), 20);

    const result = await requestDeliveryReschedule(FRAME, wanted);
    expect(result.ok).toBe(true);
    // The simulator IS the supplier, so it is entitled to say the date moved.
    if (result.ok) expect(result.value.applied).toBe(true);

    expect(salesOrder().promisedDate).toBe(wanted);
    expect(ordersStore.get().byId[FRAME]?.requestedDate).toBe(wanted);
    expect(salesOrder().tracking.at(-1)?.note).toContain('at your request');
  });

  it('re-times a truck that was already scheduled to roll', async () => {
    place();
    runSteps(3); // staged — the dispatch moment is now fixed

    const before = getContext()
      .sim.scheduler.tasks()
      .find((task) => task.type === 'order.dispatch');
    expect(before).toBeTruthy();

    const wanted = addDays(getContext().clock.nowIso(), 25);
    expect((await requestDeliveryReschedule(FRAME, wanted)).ok).toBe(true);

    const after = getContext()
      .sim.scheduler.tasks()
      .find((task) => task.type === 'order.dispatch');
    // Otherwise the new date would be cosmetic and the load would leave on the old one.
    expect(after?.dueAt).toBeGreaterThan(before?.dueAt ?? 0);
    expect(
      getContext()
        .sim.scheduler.tasks()
        .filter((task) => task.type === 'order.dispatch'),
    ).toHaveLength(1);
  });

  it('refuses once the truck is already rolling', async () => {
    place();
    runSteps(4); // out for delivery

    expect(salesOrder().status).toBe('out-for-delivery');
    const result = await requestDeliveryReschedule(FRAME, addDays(getContext().clock.nowIso(), 20));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('truck');
    // And the date is genuinely untouched, not just reported as refused.
    expect(salesOrder().promisedDate).not.toBe(addDays(getContext().clock.nowIso(), 20));
  });

  it('refuses a date that has already passed', async () => {
    place();
    const result = await requestDeliveryReschedule(FRAME, addDays(getContext().clock.nowIso(), -3));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('passed');
  });

  it('refuses on an order the supplier does not have yet', async () => {
    const result = await requestDeliveryReschedule(FRAME, addDays(getContext().clock.nowIso(), 5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('placed');
  });
});

describe('will-call pickup confirmation', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('marks it collected once it is on the counter', () => {
    place('willcall');
    runSteps(3);

    const result = confirmWillCallPickup(FRAME);
    expect(result.ok).toBe(true);

    const so = salesOrder();
    expect(so.status).toBe('delivered');
    expect(so.deliveredAt).toBeTruthy();
    expect(so.tracking.at(-1)?.note).toContain('Collected');
  });

  it('refuses before the yard has it ready', () => {
    place('willcall');

    const result = confirmWillCallPickup(FRAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("isn't on the counter yet");
  });

  it('refuses on a delivery — there is nothing to collect', () => {
    place('delivery');

    const result = confirmWillCallPickup(FRAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('truck');
  });

  it('does not leave the auto-collect behind to fire a second time', () => {
    place('willcall');
    runSteps(3);
    expect(confirmWillCallPickup(FRAME).ok).toBe(true);

    runToIdle();

    const so = salesOrder();
    expect(so.status).toBe('invoiced');
    // One collection, not two — the sim's two-day assumption was cancelled.
    expect(so.tracking.filter((entry) => entry.status === 'delivered')).toHaveLength(1);
  });

  it('bills the collected order, same as a delivery would', () => {
    place('willcall');
    runSteps(3);
    confirmWillCallPickup(FRAME);
    runToIdle();

    expect(ordersStore.get().byId[FRAME]?.stage).toBe('invoice');
  });
});

describe('site instructions', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('saves notes on an order that has not been placed yet', () => {
    const result = updateSiteInstructions(FRAME, '  Gate code 4471. Stack north of the garage.  ');

    expect(result.ok).toBe(true);
    expect(ordersStore.get().byId[FRAME]?.siteInstructions).toBe(
      'Gate code 4471. Stack north of the garage.',
    );
  });

  it('tells the supplier once they are holding the order', () => {
    place();
    const before = salesOrder().tracking.length;

    expect(updateSiteInstructions(FRAME, 'Gate code 4471.').ok).toBe(true);
    expect(salesOrder().tracking).toHaveLength(before + 1);
    expect(salesOrder().tracking.at(-1)?.note).toContain('Site instructions');
  });

  it('refuses once the driver has left with the manifest', () => {
    place();
    runSteps(4); // out for delivery

    const result = updateSiteInstructions(FRAME, 'Actually, use the back gate.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('truck has already left');
  });

  it('caps the length — the driver reads this on a handheld', () => {
    const result = updateSiteInstructions(FRAME, 'x'.repeat(401));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('400 characters');
  });
});
