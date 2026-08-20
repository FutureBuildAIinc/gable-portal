// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot, getContext } from '../../boot';
import { CARD_FEE_PERCENT } from '../../domain/payment';
import type { Invoice } from '../../domain/supplier';
import { buildArSummary, buildInvoiceRows, buildPaidInvoiceRows } from '../../selectors/ar';
import {
  invoicesStore,
  ordersStore,
  paymentMethodsStore,
  paymentsStore,
  projectsStore,
} from '../../stores/root';
import { emptyCollection, listOf } from '../../stores/store';
import { moveOrderToStage, updateOrder } from '../orders';
import {
  defaultPaymentMethod,
  payInvoices,
  quotePayment,
  removePaymentMethod,
  savePaymentMethod,
  setDefaultPaymentMethod,
} from '../payments';

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

const MILLER_FRAME = 'ord_miller_frame'; // fully ERP-priced, so it can go straight to Order
const WILSON_TRIM = 'ord_wilson_trim';

const ACH = 'pm_ach';
const VISA = 'pm_visa';
const BAD_CARD = 'pm_bad'; // always declines

/** Runs the supplier simulation to a standstill: confirm -> pick -> deliver -> invoice. */
function runSupplier(): void {
  let guard = 0;
  while (getContext().sim.control.skipToNextEvent()) {
    if (++guard > 300) throw new Error('the simulator never settled');
  }
}

/**
 * The demo scenario seeds open AR so the Pay screen is not empty on a fresh
 * boot. These tests are about the payment machinery rather than the demo data,
 * so they start from an empty ledger and raise their own invoices. The seeded
 * AR gets its own test at the bottom.
 */
function bootWithEmptyLedger(): void {
  boot({ reset: true, seed: 20_260_730 });
  invoicesStore.set(emptyCollection());
}

/** Puts one order all the way through the supplier so an invoice exists. */
function billOrder(orderId: string): Invoice {
  // The sim clock may have skipped past the seeded requested date by now, and
  // the stage machine (correctly) refuses to place an order for a date that
  // has already passed — so do what a contractor would: pick a fresh one.
  const { clock } = getContext();
  const tomorrow = new Date(clock.now() + 24 * 60 * 60 * 1000).toISOString();
  const redated = updateOrder(orderId, { requestedDate: tomorrow });
  if (!redated.ok) throw new Error(redated.error);

  const moved = moveOrderToStage(orderId, 'order');
  if (!moved.ok) throw new Error(moved.error);
  runSupplier();

  const invoice = listOf(invoicesStore.get()).find((candidate) => candidate.orderId === orderId);
  if (!invoice) throw new Error(`no invoice was raised for ${orderId}`);
  return invoice;
}

function reread(invoiceId: string): Invoice {
  const invoice = invoicesStore.get().byId[invoiceId];
  if (!invoice) throw new Error('invoice vanished');
  return invoice;
}

function now(): string {
  return getContext().clock.nowIso();
}

describe('aging', () => {
  beforeEach(bootWithEmptyLedger);

  it('buckets an invoice by how far past due it is', () => {
    const invoice = billOrder(MILLER_FRAME); // NET30

    const fresh = buildArSummary(invoicesStore.get(), now());
    expect(fresh.outstanding).toBe(invoice.balance);
    expect(fresh.overdue).toBe(0);
    expect(fresh.buckets.find((slice) => slice.bucket === 'current')?.count).toBe(1);

    // Terms are net 30, so 45 days past issue is 15 days late.
    getContext().sim.control.advanceDays(45);
    const late = buildArSummary(invoicesStore.get(), now());
    expect(late.overdue).toBe(invoice.balance);
    expect(late.overdueCount).toBe(1);
    expect(late.buckets.find((slice) => slice.bucket === '1-30')?.total).toBe(invoice.balance);

    getContext().sim.control.advanceDays(30); // 45 days late
    expect(
      buildArSummary(invoicesStore.get(), now()).buckets.find((s) => s.bucket === '31-60')?.count,
    ).toBe(1);

    getContext().sim.control.advanceDays(40); // 85 days late
    expect(
      buildArSummary(invoicesStore.get(), now()).buckets.find((s) => s.bucket === '60+')?.count,
    ).toBe(1);
  });

  it('always reports all four buckets, even at zero', () => {
    const summary = buildArSummary(invoicesStore.get(), now());
    expect(summary.buckets.map((slice) => slice.bucket)).toEqual([
      'current',
      '1-30',
      '31-60',
      '60+',
    ]);
    expect(summary.outstanding).toBe(0);
  });

  it('names the job an invoice was for, and puts the latest one first', () => {
    const first = billOrder(MILLER_FRAME);
    getContext().sim.control.advanceDays(40); // the Miller invoice goes late
    const second = billOrder(WILSON_TRIM);

    const rows = buildInvoiceRows(
      invoicesStore.get(),
      ordersStore.get(),
      projectsStore.get(),
      now(),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.invoice.id).toBe(first.id);
    expect(rows[0]?.overdue).toBe(true);
    expect(rows[0]?.daysOverdue).toBeGreaterThan(0);
    // The project name, not the invoice number — that is what the money was for.
    expect(rows[0]?.label).toBe('Miller Residence — Deck');
    expect(rows[0]?.orderId).toBe(MILLER_FRAME);
    expect(rows[1]?.invoice.id).toBe(second.id);
    expect(rows[1]?.overdue).toBe(false);
  });
});

describe('paying', () => {
  beforeEach(bootWithEmptyLedger);

  it('clears one invoice and hands back a confirmation number', () => {
    const invoice = billOrder(MILLER_FRAME);

    const result = payInvoices({ invoiceIds: [invoice.id], methodId: ACH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('succeeded');
    expect(result.value.confirmationNumber).toBe('PMT-10001');
    expect(result.value.amount).toBe(invoice.balance);
    expect(reread(invoice.id).balance).toBe(0);
    expect(buildArSummary(invoicesStore.get(), now()).outstanding).toBe(0);
  });

  it('settles several invoices in one payment', () => {
    const first = billOrder(MILLER_FRAME);
    const second = billOrder(WILSON_TRIM);
    const owed = first.balance + second.balance;

    const result = payInvoices({ invoiceIds: [first.id, second.id], methodId: ACH });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.allocations).toHaveLength(2);
    expect(result.value.amount).toBe(owed);
    expect(reread(first.id).balance).toBe(0);
    expect(reread(second.id).balance).toBe(0);
    // One payment, not two — that is the "few clicks" claim made literal.
    expect(listOf(paymentsStore.get())).toHaveLength(1);
  });

  it('moves a paid invoice out of the open list and into history', () => {
    const invoice = billOrder(MILLER_FRAME);
    payInvoices({ invoiceIds: [invoice.id], methodId: ACH });

    const open = buildInvoiceRows(
      invoicesStore.get(),
      ordersStore.get(),
      projectsStore.get(),
      now(),
    );
    const paid = buildPaidInvoiceRows(invoicesStore.get(), ordersStore.get(), projectsStore.get());

    expect(open).toHaveLength(0);
    expect(paid).toHaveLength(1);
    expect(paid[0]?.label).toBe('Miller Residence — Deck');
  });

  it('refuses an invoice that is already paid', () => {
    const invoice = billOrder(MILLER_FRAME);
    payInvoices({ invoiceIds: [invoice.id], methodId: ACH });

    const again = payInvoices({ invoiceIds: [invoice.id], methodId: ACH });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('already been paid');
  });

  it('refuses an empty selection and an unknown method', () => {
    const invoice = billOrder(MILLER_FRAME);

    expect(payInvoices({ invoiceIds: [], methodId: ACH }).ok).toBe(false);
    expect(payInvoices({ invoiceIds: [invoice.id], methodId: 'pm_nope' }).ok).toBe(false);
    // Nothing was touched by either rejection.
    expect(reread(invoice.id).balance).toBe(invoice.balance);
  });
});

describe('the cost of paying by card', () => {
  beforeEach(bootWithEmptyLedger);

  it('charges 2.9% on a card and nothing on ACH', () => {
    const invoice = billOrder(MILLER_FRAME);

    const byAch = quotePayment([invoice.id], ACH);
    const byCard = quotePayment([invoice.id], VISA);
    expect(byAch.ok && byCard.ok).toBe(true);
    if (!byAch.ok || !byCard.ok) return;

    expect(byAch.value.fee).toBe(0);
    expect(byAch.value.total).toBe(invoice.balance);
    expect(byCard.value.fee).toBe(Math.round(invoice.balance * (CARD_FEE_PERCENT / 100)));
    expect(byCard.value.total).toBe(invoice.balance + byCard.value.fee);
    // On a real material invoice this is not a rounding error.
    expect(byCard.value.fee).toBeGreaterThan(1000);
  });

  it('adds the fee on top rather than skimming it off the balance', () => {
    const invoice = billOrder(MILLER_FRAME);

    const result = payInvoices({ invoiceIds: [invoice.id], methodId: VISA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.amount).toBeGreaterThan(invoice.balance);
    // The supplier is made whole; the fee is the contractor's cost of convenience.
    expect(result.value.allocations[0]?.amount).toBe(invoice.balance);
    expect(reread(invoice.id).balance).toBe(0);
  });
});

describe('a decline', () => {
  beforeEach(bootWithEmptyLedger);

  it('leaves every balance exactly where it was', () => {
    const invoice = billOrder(MILLER_FRAME);

    const result = payInvoices({ invoiceIds: [invoice.id], methodId: BAD_CARD });
    // The action succeeded; the payment did not. Those are different things,
    // and the UI needs the failed payment to show the reason.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('failed');
    expect(result.value.failureReason).toBe('Card declined by issuer.');
    expect(result.value.confirmationNumber).toBeUndefined();
    expect(reread(invoice.id).balance).toBe(invoice.balance);
    expect(buildArSummary(invoicesStore.get(), now()).outstanding).toBe(invoice.balance);
  });

  it('lets a second method settle the same invoice, and burns no confirmation number', () => {
    const invoice = billOrder(MILLER_FRAME);

    payInvoices({ invoiceIds: [invoice.id], methodId: BAD_CARD });
    const retry = payInvoices({ invoiceIds: [invoice.id], methodId: ACH });

    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.status).toBe('succeeded');
    expect(retry.value.confirmationNumber).toBe('PMT-10001');
    expect(reread(invoice.id).balance).toBe(0);
  });
});

describe('saved methods', () => {
  beforeEach(bootWithEmptyLedger);

  it('stores a display label and refuses anything shaped like a card number', () => {
    const good = savePaymentMethod({ kind: 'card', label: 'Amex •••• 1005' });
    expect(good.ok).toBe(true);

    const bad = savePaymentMethod({ kind: 'card', label: '4242 4242 4242 4242' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('never a full card number');
  });

  it('moves the default flag rather than duplicating it', () => {
    expect(setDefaultPaymentMethod(VISA).ok).toBe(true);

    const methods = listOf(paymentMethodsStore.get());
    expect(methods.filter((method) => method.isDefault).map((method) => method.id)).toEqual([VISA]);
  });

  it('will not leave the account with nothing to pay with', () => {
    expect(removePaymentMethod(VISA).ok).toBe(true);
    expect(removePaymentMethod(BAD_CARD).ok).toBe(true);

    const last = removePaymentMethod(ACH);
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error).toContain('at least one');
  });

  it('promotes a survivor when the default is removed', () => {
    expect(removePaymentMethod(ACH).ok).toBe(true); // ACH is the seeded default

    const methods = listOf(paymentMethodsStore.get());
    expect(methods.filter((method) => method.isDefault)).toHaveLength(1);
    // The sheet preselects the default, so leaving none would open on nothing.
    expect(defaultPaymentMethod()?.id).not.toBe(ACH);
  });
});

describe('the seeded ledger', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('gives the Invoice-stage card something to actually pay', () => {
    // A card sitting in the Invoice column with no invoice behind it reads as
    // a bug, so the Kirkland job is billed in the scenario.
    const kirkland = invoicesStore.get().byId.inv_kirkland;
    expect(kirkland).toBeTruthy();
    expect(kirkland?.orderId).toBe('ord_kirkland');
    expect(kirkland?.balance).toBeGreaterThan(0);
  });

  it('includes a counter sale that never went through the portal', () => {
    // The all-in-one AR claim only holds if material bought at the trade desk
    // lands in the same bucket as everything ordered online.
    const counter = invoicesStore.get().byId.inv_counter;
    expect(counter?.origin).toBe('counter');
    expect(counter?.orderId).toBeUndefined();
  });

  it('opens with something overdue, so aging has teeth on load', () => {
    const summary = buildArSummary(invoicesStore.get(), getContext().clock.nowIso());
    expect(summary.outstanding).toBeGreaterThan(0);
    expect(summary.overdueCount).toBeGreaterThan(0);
  });

  it('labels a counter sale as an in-store purchase', () => {
    const rows = buildInvoiceRows(
      invoicesStore.get(),
      ordersStore.get(),
      projectsStore.get(),
      getContext().clock.nowIso(),
    );
    const counter = rows.find((row) => row.invoice.id === 'inv_counter');
    expect(counter?.label.toLowerCase()).toContain('in-store');
  });
});
