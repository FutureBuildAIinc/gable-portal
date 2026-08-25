// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  reviseCustomerQuote,
  sendCustomerQuote,
  updateCustomerQuote,
} from '../actions/customer-quote';
import { buildCustomerQuote, quoteForOrder } from '../actions/customer-quote';
import { requestDeliveryReschedule } from '../actions/fulfillment';
import { moveOrderToStage, updateOrder } from '../actions/orders';
import { toolByName } from '../ai/tools';
import { boot, getContext } from '../boot';
import { resetConfigCache } from '../config/runtime';
import { DEFAULT_CONFIG } from '../domain/config';
import { agingBucket, isOverdue } from '../domain/payment';
import { hasKnownSubtotal, orderTotals } from '../domain/totals';
import { addDays } from '../lib/time';
import { flushPersistence } from '../stores/persistence';
import {
  customerQuotesStore,
  invoicesStore,
  ordersStore,
  quotesStore,
  salesOrdersStore,
  scopeStore,
  simStore,
} from '../stores/root';
import { listOf } from '../stores/store';

/**
 * Regressions from the L8 review. Every test here reproduces a CONFIRMED
 * finding as it was reported — a scenario a contractor could actually hit —
 * and pins the fix. If one of these fails, the bug it names is back.
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

const MILLER_FRAME = 'ord_miller_frame'; // fully priced, straight to Order
const MILLER_DECK = 'ord_miller_deck'; // carries an unpriced special-order line

function control() {
  return getContext().sim.control;
}

function skipUntil(predicate: () => boolean, label: string): void {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    if (!control().skipToNextEvent()) break;
  }
  if (!predicate()) throw new Error(`never reached: ${label}`);
}

function salesOrderFor(orderId: string) {
  const order = ordersStore.get().byId[orderId];
  const soId = order?.salesOrderId;
  return soId ? salesOrdersStore.get().byId[soId] : undefined;
}

function redate(orderId: string, daysOut = 1): void {
  const date = addDays(getContext().clock.nowIso(), daysOut);
  const result = updateOrder(orderId, { requestedDate: date });
  if (!result.ok) throw new Error(result.error);
}

beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

describe('cancelling a placed order', () => {
  it('is refused once the truck is rolling', () => {
    redate(MILLER_FRAME);
    expect(moveOrderToStage(MILLER_FRAME, 'order').ok).toBe(true);

    skipUntil(() => salesOrderFor(MILLER_FRAME)?.status === 'out-for-delivery', 'dispatch');

    const pulled = moveOrderToStage(MILLER_FRAME, 'plan');
    expect(pulled.ok).toBe(false);
    if (pulled.ok) return;
    expect(pulled.error).toMatch(/on the truck/i);
    // And the sales order was NOT cancelled underneath the refusal.
    expect(salesOrderFor(MILLER_FRAME)?.status).toBe('out-for-delivery');
  });

  it('is refused after delivery, so the pending invoice cannot be erased', () => {
    redate(MILLER_FRAME);
    moveOrderToStage(MILLER_FRAME, 'order');
    skipUntil(() => salesOrderFor(MILLER_FRAME)?.status === 'delivered', 'delivery');

    const pulled = moveOrderToStage(MILLER_FRAME, 'plan');
    expect(pulled.ok).toBe(false);

    // The bill still arrives.
    skipUntil(
      () => listOf(invoicesStore.get()).some((inv) => inv.orderId === MILLER_FRAME),
      'invoice',
    );
  });

  it('is still allowed while the goods are only confirmed or picking', () => {
    redate(MILLER_FRAME);
    moveOrderToStage(MILLER_FRAME, 'order');
    skipUntil(() => salesOrderFor(MILLER_FRAME)?.status === 'confirmed', 'confirmation');

    expect(moveOrderToStage(MILLER_FRAME, 'plan').ok).toBe(true);
    expect(salesOrderFor(MILLER_FRAME)?.status).toBe('cancelled');
  });
});

describe('editing an order the supplier holds', () => {
  it('refuses a silent date change once placed, pointing at reschedule', () => {
    redate(MILLER_FRAME);
    moveOrderToStage(MILLER_FRAME, 'order');

    const changed = updateOrder(MILLER_FRAME, {
      requestedDate: addDays(getContext().clock.nowIso(), 9),
    });
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error).toMatch(/reschedule/i);
  });

  it('refuses placing an order for a date that has already passed', () => {
    control().advanceDays(30); // sail past the seeded Aug requested date
    const moved = moveOrderToStage(MILLER_FRAME, 'order');
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.error).toMatch(/already passed/i);
  });
});

describe('the quote desk after a price lapses', () => {
  it('re-prices an expired line instead of looping the contractor forever', () => {
    // Route the deck order (special line) through the desk.
    moveOrderToStage(MILLER_DECK, 'quote');
    skipUntil(
      () =>
        quotesStore.get().byId[ordersStore.get().byId[MILLER_DECK]?.quoteId ?? '']?.status ===
        'priced',
      'first pricing',
    );

    // Let the 14-day hold lapse.
    control().advanceDays(20);
    moveOrderToStage(MILLER_DECK, 'plan');

    const blocked = moveOrderToStage(MILLER_DECK, 'order');
    expect(blocked.ok).toBe(false); // expired price re-blocks — correct

    // The prescribed remedy must actually work: back to the desk...
    expect(moveOrderToStage(MILLER_DECK, 'quote').ok).toBe(true);
    skipUntil(() => {
      const quoteId = ordersStore.get().byId[MILLER_DECK]?.quoteId;
      return quoteId ? quotesStore.get().byId[quoteId]?.status === 'priced' : false;
    }, 'second pricing');

    // ...and the fresh price unblocks the order.
    const special = listOf(scopeStore.get()).find(
      (item) => item.orderId === MILLER_DECK && item.kind === 'special',
    );
    const freshExpiry = special?.priceExpiresAt;
    expect(freshExpiry).toBeDefined();
    // ISO strings sort lexicographically, so a plain compare is the date compare.
    expect((freshExpiry ?? '') > getContext().clock.nowIso()).toBe(true);

    redate(MILLER_DECK);
    expect(moveOrderToStage(MILLER_DECK, 'order').ok).toBe(true);
  });
});

describe('offline catch-up', () => {
  it('advances the whole chain in one boot, not one step per reload', () => {
    moveOrderToStage(MILLER_DECK, 'quote');

    // Simulate closing the tab for two days: advance the persisted clock
    // anchor backwards so boot sees two days of elapsed sim time, then reboot
    // WITHOUT reset. Every chained step (review -> price) is overdue.
    flushPersistence();
    const sim = simStore.get();
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    simStore.set({ ...sim, anchorReal: sim.anchorReal - twoDays });
    flushPersistence();

    boot({ seed: 20_260_730 }); // no reset: restore + catch up

    const quoteId = ordersStore.get().byId[MILLER_DECK]?.quoteId;
    const quote = quoteId ? quotesStore.get().byId[quoteId] : undefined;
    // ~90min review + ~5h pricing both fit in two days: the desk must have
    // finished while we were away, not restarted its clock at reload.
    expect(quote?.status).toBe('priced');
  });
});

describe('will-call pickup timing', () => {
  function placeWillCall(): void {
    updateOrder(MILLER_FRAME, { fulfillment: 'willcall' });
    redate(MILLER_FRAME);
    const moved = moveOrderToStage(MILLER_FRAME, 'order');
    if (!moved.ok) throw new Error(moved.error);
    skipUntil(() => salesOrderFor(MILLER_FRAME)?.status === 'ready-willcall', 'staging');
  }

  it('rescheduling the pickup re-times the auto-collect, not just the label', async () => {
    placeWillCall();

    const newPickup = addDays(getContext().clock.nowIso(), 6);
    // Asynchronous since the reschedule goes through the supplier port: the
    // simulator applies it, a real ERP records a request. Same call either way.
    const rescheduled = await requestDeliveryReschedule(MILLER_FRAME, newPickup);
    expect(rescheduled.ok).toBe(true);
    if (rescheduled.ok) expect(rescheduled.value.applied).toBe(true);

    // Run the world forward to just before the new pickup day.
    control().advanceDays(4);
    expect(salesOrderFor(MILLER_FRAME)?.status).toBe('ready-willcall');

    // On/after the pickup day it may collect and bill.
    control().advanceDays(3);
    expect(['delivered', 'invoiced']).toContain(salesOrderFor(MILLER_FRAME)?.status);
  });
});

describe('the customer quote', () => {
  it('will not build over a line the dealer has not priced', () => {
    const built = buildCustomerQuote(MILLER_DECK);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/no dealer price/i);
  });

  it('freezes at send: edits are refused until an explicit revise', () => {
    const built = buildCustomerQuote(MILLER_FRAME);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    updateCustomerQuote(built.value.id, { customer: { name: 'Dana Miller' } });
    const sent = sendCustomerQuote(built.value.id);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;

    const tokenAtSend = sent.value.shareToken;

    // The live link's numbers must not move.
    const bumped = updateCustomerQuote(built.value.id, { markupPercent: 45 });
    expect(bumped.ok).toBe(false);

    // Revise reopens editing AND kills the old link immediately.
    const revised = reviseCustomerQuote(built.value.id);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.status).toBe('draft');
    expect(revised.value.shareToken).not.toBe(tokenAtSend);

    expect(updateCustomerQuote(built.value.id, { markupPercent: 30 }).ok).toBe(true);
  });

  it('never leaves an accepted quote revisable', () => {
    const built = buildCustomerQuote(MILLER_FRAME);
    if (!built.ok) throw new Error(built.error);
    updateCustomerQuote(built.value.id, { customer: { name: 'Dana Miller' } });
    sendCustomerQuote(built.value.id);
    const quote = quoteForOrder(MILLER_FRAME);
    if (!quote) throw new Error('quote vanished');
    customerQuotesStore.set({
      ...customerQuotesStore.get(),
      byId: {
        ...customerQuotesStore.get().byId,
        [quote.id]: { ...quote, status: 'accepted' as const },
      },
    });

    expect(reviseCustomerQuote(quote.id).ok).toBe(false);
  });
});

describe('the pay_invoices approval prompt', () => {
  it('names the fee-inclusive amount when the method is a card', () => {
    const openInvoice = listOf(invoicesStore.get()).find((inv) => inv.balance > 0);
    expect(openInvoice).toBeDefined();
    if (!openInvoice) return;

    const tool = toolByName('pay_invoices');
    const prompt = tool?.confirm?.({ invoiceIds: [openInvoice.id], methodId: 'pm_visa' }) ?? '';
    // 2.9% of the balance, rounded — the number the charge will actually be.
    const fee = Math.round(openInvoice.balance * 0.029);
    const total = openInvoice.balance + fee;
    expect(prompt).toContain((total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }));
    expect(prompt).toMatch(/card fee/i);
  });

  it('does not double-count a duplicated invoice id', () => {
    const openInvoice = listOf(invoicesStore.get()).find((inv) => inv.balance > 0);
    if (!openInvoice) return;
    const tool = toolByName('pay_invoices');
    const once = tool?.confirm?.({ invoiceIds: [openInvoice.id], methodId: 'pm_ach' }) ?? '';
    const twice =
      tool?.confirm?.({ invoiceIds: [openInvoice.id, openInvoice.id], methodId: 'pm_ach' }) ?? '';
    expect(twice).toBe(once);
  });
});

describe('overdue reckoning', () => {
  it('agrees with the aging buckets hour by hour', () => {
    const due = '2026-07-30T18:00:00.000Z';

    // Six hours past the timestamp: not a full day late yet, so neither
    // overdue nor out of Current — the headline and the tiles must agree.
    expect(isOverdue(due, '2026-07-31T00:00:00.000Z')).toBe(false);
    expect(agingBucket(due, '2026-07-31T00:00:00.000Z')).toBe('current');

    // Thirty hours past: one day late in both places.
    expect(isOverdue(due, '2026-08-01T00:00:00.000Z')).toBe(true);
    expect(agingBucket(due, '2026-08-01T00:00:00.000Z')).toBe('1-30');
  });
});

describe('corrupt persisted state', () => {
  it('reseeds instead of restoring garbage', () => {
    flushPersistence();
    localStorage.setItem('gn:orders', '{"byId": "not a map", "allIds": 7}');

    expect(() => boot({ seed: 20_260_730 })).not.toThrow();
    // A reseed, not a half-restore: the seeded board is back.
    expect(ordersStore.get().byId[MILLER_FRAME]).toBeDefined();
  });

  it('reseeds on unparseable JSON without throwing', () => {
    flushPersistence();
    localStorage.setItem('gn:scope', '{truncated');
    expect(() => boot({ seed: 20_260_730 })).not.toThrow();
    expect(listOf(scopeStore.get()).length).toBeGreaterThan(0);
  });
});

describe('the demo clock', () => {
  it('survives a speed change immediately followed by a reload', () => {
    const before = getContext().clock.now();

    control().setSpeed(3600);
    // The contractor reloads within the old 2s reconcile window.
    flushPersistence();
    boot({ seed: 20_260_730 });

    const after = getContext().clock.now();
    // A torn {old anchor, new speed} pair replayed the anchor gap at 3600x —
    // months of sim time. Intact, the jump is however long boot itself took.
    expect(after - before).toBeLessThan(60_000);
  });
});

describe('the scheduler under a faulty handler', () => {
  it('drops only the throwing task, never its due siblings', () => {
    const { scheduler } = getContext().sim;
    const ran: string[] = [];
    scheduler.on('test.bad', () => {
      throw new Error('boom');
    });
    scheduler.on('test.good', () => {
      ran.push('good');
    });

    scheduler.schedule('test.bad', 1000, {});
    scheduler.schedule('test.good', 2000, {});
    control().advanceDays(1);

    expect(ran).toEqual(['good']);
  });
});

describe('the dealer name is configuration, not a literal', () => {
  /**
   * `companyName` is settable in the admin console, but the demo dealer's name
   * was written into ~40 contractor-facing sentences — so a deployment for
   * anyone else told its contractors that "Gable Supply will price this".
   *
   * The behavioural half: a refusal a contractor actually reads.
   */
  it('names the configured supplier in a refusal', () => {
    resetConfigCache({
      ...DEFAULT_CONFIG,
      branding: { ...DEFAULT_CONFIG.branding, companyName: 'Kelly-Fradet' },
    });
    try {
      const placed = listOf(ordersStore.get()).find((order) => order.stage === 'order');
      const refusal = updateOrder(placed?.id ?? '', {
        requestedDate: addDays(getContext().clock.nowIso(), 30),
      });

      expect(refusal.ok).toBe(false);
      expect(refusal.ok ? '' : refusal.error).toContain('Kelly-Fradet');
    } finally {
      resetConfigCache();
    }
  });

  /**
   * The durable half. One rename is a bug; forty is a class of bug, and only a
   * whole-tree check keeps the forty-first from landing. Comments are stripped
   * — they describe the demo dealer and are not shipped to anyone.
   */
  it('leaves no hardcoded dealer name in shipped copy', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // The default config is the ONE place the demo dealer may be named.
        if (full.endsWith(join('domain', 'config.ts'))) continue;

        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        // The PRODUCT is GableNow and its identifiers legitimately carry the
        // stem — GableNow, GableMark, and whatever comes next. Strip
        // PascalCase compounds (Gable followed by a capital) and check what is
        // left, so the guard maintains itself as the brand vocabulary grows.
        //
        // Deliberately narrow: "Gable Supply" has a space and "Gable will
        // price this" has a lowercase w, so both still get caught. Relaxing
        // this to a plain "Gable Supply" match would let that second sentence
        // back in, and it is the exact one the guard was written for.
        //
        // The second replace covers the mirror case, added when the ERP client
        // landed: `loginToGable`, `initGableConnection`, `isGableWired` — the
        // integration is named after the repository it talks to, and those are
        // identifiers, not copy. Only a `Gable` that ends a camelCase word is
        // stripped, so "the Gable quote desk" (preceded by a space) and
        // "Gable Supply" are both still caught.
        const withoutProductNames = code
          .replace(/Gable(?=[A-Z])[A-Za-z]*/g, '')
          .replace(/(?<=[a-z0-9])Gable\b/g, '');
        if (withoutProductNames.includes('Gable')) offenders.push(full.slice(root.length));
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('a total nobody can stand behind is not a number', () => {
  it('reports an all-unpriced order as unknown, not zero', () => {
    const unpriced = orderTotals([{ unitPrice: undefined, listPrice: undefined, qty: 3 }] as never);
    expect(unpriced.subtotal).toBe(0);
    expect(hasKnownSubtotal(unpriced)).toBe(false);
  });

  it('keeps the subtotal when only SOME lines are unpriced', () => {
    const order = listOf(ordersStore.get()).find((entry) => entry.stage === 'plan');
    const items = listOf(scopeStore.get()).filter((item) => item.orderId === order?.id);
    if (items.length > 0) {
      const totals = orderTotals(items);
      if (totals.unpricedCount < totals.itemCount) {
        expect(hasKnownSubtotal(totals)).toBe(true);
      }
    }
    expect(hasKnownSubtotal({ itemCount: 0, unpricedCount: 0 } as never)).toBe(false);
  });
});
