// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { Order, Project } from '../../domain/project';
import type { Invoice } from '../../domain/supplier';
import { type Collection, collectionFrom } from '../../stores/store';
import { buildArSummary, buildInvoiceRows, buildPaidInvoiceRows, selectedTotal } from '../ar';

/**
 * Accounts receivable. Every figure on this screen is a claim about money the
 * contractor owes, and `selectedTotal` is the number that goes onto a card.
 *
 * The aging arithmetic is the subtle part. `daysPastDue` is THE definition, and
 * `agingBucket` and `isOverdue` are both derived from it — they used to disagree
 * (the bucket floored to whole days while `isOverdue` compared raw timestamps),
 * so an invoice due yesterday evening spent a day counted in the overdue
 * headline while filed under "Current" on the same screen. These tests pin the
 * boundaries so that cannot come back.
 */

const NOW = '2026-08-20T12:00:00.000Z';

/** `n` whole days before NOW, at the same time of day. */
function daysBeforeNow(n: number): string {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
}

let seq = 0;

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `inv_${seq}`,
    number: `INV-${9000 + seq}`,
    accountId: 'acct_summit',
    origin: 'portal',
    issuedAt: daysBeforeNow(40),
    dueAt: daysBeforeNow(10),
    subtotal: 100_000,
    balance: 100_000,
    description: 'Materials',
    ...overrides,
  };
}

const NO_ORDERS: Collection<Order> = collectionFrom([]);
const NO_PROJECTS: Collection<Project> = collectionFrom([]);

const ORDER: Order = {
  id: 'ord_1',
  projectId: 'prj_1',
  name: 'Deck framing',
  stage: 'invoice',
  fulfillment: 'delivery',
  createdAt: NOW,
  updatedAt: NOW,
  sortOrder: 0,
};

const PROJECT: Project = {
  id: 'prj_1',
  accountId: 'acct_summit',
  name: 'Miller Residence — Deck',
  createdAt: NOW,
  updatedAt: NOW,
};

const ORDERS = collectionFrom([ORDER]);
const PROJECTS = collectionFrom([PROJECT]);

describe('buildArSummary', () => {
  it('sums only open balances, and counts the overdue ones separately', () => {
    const summary = buildArSummary(
      collectionFrom([
        invoice({ balance: 250_00, dueAt: daysBeforeNow(5) }), // overdue
        invoice({ balance: 400_00, dueAt: daysBeforeNow(-7) }), // due in a week
        invoice({ balance: 0, dueAt: daysBeforeNow(90) }), // paid, excluded entirely
      ]),
      NOW,
    );

    expect(summary.outstanding).toBe(650_00);
    expect(summary.openCount).toBe(2);
    expect(summary.overdue).toBe(250_00);
    expect(summary.overdueCount).toBe(1);
  });

  it('always reports all four buckets, including the empty ones', () => {
    // An empty "60+" column is information — it says nothing is that late. A
    // bar whose columns appear and vanish as balances age is unreadable.
    const summary = buildArSummary(collectionFrom([]), NOW);

    expect(summary.buckets.map((b) => b.bucket)).toEqual(['current', '1-30', '31-60', '60+']);
    expect(summary.buckets.every((b) => b.total === 0 && b.count === 0)).toBe(true);
  });

  it('files each open balance in exactly one bucket', () => {
    const summary = buildArSummary(
      collectionFrom([
        invoice({ balance: 100_00, dueAt: daysBeforeNow(-1) }), // not yet due -> current
        invoice({ balance: 200_00, dueAt: daysBeforeNow(15) }), // 1-30
        invoice({ balance: 300_00, dueAt: daysBeforeNow(45) }), // 31-60
        invoice({ balance: 400_00, dueAt: daysBeforeNow(75) }), // 60+
      ]),
      NOW,
    );

    expect(summary.buckets.map((b) => b.total)).toEqual([100_00, 200_00, 300_00, 400_00]);
    expect(summary.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1]);
    // The buckets must partition the outstanding total — no double counting.
    expect(summary.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(summary.outstanding);
  });

  it('agrees with itself at the bucket boundaries', () => {
    // Exactly 30 days late is "1-30"; 31 is "31-60". Exactly 60 is "31-60";
    // 61 is "60+". Off-by-one here moves real money between columns.
    const at = (days: number) =>
      buildArSummary(
        collectionFrom([invoice({ balance: 1, dueAt: daysBeforeNow(days) })]),
        NOW,
      ).buckets.find((b) => b.count === 1)?.bucket;

    expect(at(0)).toBe('current');
    expect(at(1)).toBe('1-30');
    expect(at(30)).toBe('1-30');
    expect(at(31)).toBe('31-60');
    expect(at(60)).toBe('31-60');
    expect(at(61)).toBe('60+');
  });

  it('does not count an invoice due later today as overdue', () => {
    // Due in eight hours. `daysPastDue` floors to whole days, so this is 0.
    const dueLaterToday = new Date(Date.parse(NOW) + 8 * 3_600_000).toISOString();
    const summary = buildArSummary(
      collectionFrom([invoice({ balance: 500_00, dueAt: dueLaterToday })]),
      NOW,
    );

    expect(summary.overdue).toBe(0);
    expect(summary.overdueCount).toBe(0);
    // ...and it is filed as current, not as 1-30. The headline and the tile
    // have to tell the same story.
    expect(summary.buckets[0]?.count).toBe(1);
  });
});

describe('buildInvoiceRows', () => {
  it('puts the most overdue first, because that is why the page was opened', () => {
    const rows = buildInvoiceRows(
      collectionFrom([
        invoice({ id: 'inv_mid', number: 'INV-2', dueAt: daysBeforeNow(10) }),
        invoice({ id: 'inv_worst', number: 'INV-3', dueAt: daysBeforeNow(45) }),
        invoice({ id: 'inv_fine', number: 'INV-1', dueAt: daysBeforeNow(-5) }),
      ]),
      NO_ORDERS,
      NO_PROJECTS,
      NOW,
    );

    expect(rows.map((r) => r.invoice.id)).toEqual(['inv_worst', 'inv_mid', 'inv_fine']);
    expect(rows.map((r) => r.daysOverdue)).toEqual([45, 10, 0]);
  });

  it('breaks a tie by due date, then by invoice number, so the order is stable', () => {
    const rows = buildInvoiceRows(
      collectionFrom([
        invoice({ id: 'b', number: 'INV-9002', dueAt: daysBeforeNow(5) }),
        invoice({ id: 'a', number: 'INV-9001', dueAt: daysBeforeNow(5) }),
      ]),
      NO_ORDERS,
      NO_PROJECTS,
      NOW,
    );

    expect(rows.map((r) => r.invoice.id)).toEqual(['a', 'b']);
  });

  it('excludes settled invoices', () => {
    const rows = buildInvoiceRows(
      collectionFrom([invoice({ balance: 0 }), invoice({ balance: 1 })]),
      NO_ORDERS,
      NO_PROJECTS,
      NOW,
    );
    expect(rows).toHaveLength(1);
  });

  it('labels a bill with the job name, not the invoice number', () => {
    // "INV-9007" tells a contractor nothing. "Miller Residence — Deck" tells
    // them everything, which is the whole reason this selector exists.
    const rows = buildInvoiceRows(
      collectionFrom([invoice({ orderId: 'ord_1' })]),
      ORDERS,
      PROJECTS,
      NOW,
    );

    expect(rows[0]?.label).toBe('Miller Residence — Deck');
    expect(rows[0]?.orderId).toBe('ord_1');
  });

  it('falls back to the order name when the project is gone', () => {
    const rows = buildInvoiceRows(
      collectionFrom([invoice({ orderId: 'ord_1' })]),
      ORDERS,
      NO_PROJECTS,
      NOW,
    );
    expect(rows[0]?.label).toBe('Deck framing');
  });

  it('names a counter sale as one rather than leaving a balance unexplained', () => {
    // A contractor who sees an unexplained balance assumes a billing error and
    // phones the dealer.
    const rows = buildInvoiceRows(
      // No `orderId` at all — the default fixture omits it, which is what a
      // counter sale looks like. `exactOptionalPropertyTypes` means an explicit
      // `orderId: undefined` would not even type-check, and that is the point:
      // absent and "present but undefined" are different states here.
      collectionFrom([invoice({ origin: 'counter' })]),
      ORDERS,
      PROJECTS,
      NOW,
    );
    expect(rows[0]?.label).toBe('In-store purchase');
    expect(rows[0]?.orderId).toBeUndefined();
  });

  it('drops a dangling order id instead of rendering a dead link', () => {
    const rows = buildInvoiceRows(
      collectionFrom([invoice({ orderId: 'ord_deleted' })]),
      ORDERS,
      PROJECTS,
      NOW,
    );
    expect(rows[0]?.orderId).toBeUndefined();
    // With no order and no project to name it, the description carries the label.
    expect(rows[0]?.label).toBe('Materials');
  });
});

describe('buildPaidInvoiceRows', () => {
  it('lists only settled invoices, most recently issued first', () => {
    const rows = buildPaidInvoiceRows(
      collectionFrom([
        invoice({ id: 'old', balance: 0, issuedAt: daysBeforeNow(90) }),
        invoice({ id: 'recent', balance: 0, issuedAt: daysBeforeNow(3) }),
        invoice({ id: 'open', balance: 5000, issuedAt: daysBeforeNow(1) }),
      ]),
      NO_ORDERS,
      NO_PROJECTS,
    );

    expect(rows.map((r) => r.invoice.id)).toEqual(['recent', 'old']);
  });

  it('labels history the same way the open list does', () => {
    const rows = buildPaidInvoiceRows(
      collectionFrom([invoice({ balance: 0, orderId: 'ord_1' })]),
      ORDERS,
      PROJECTS,
    );
    expect(rows[0]?.label).toBe('Miller Residence — Deck');
  });
});

describe('selectedTotal', () => {
  const ROWS = buildInvoiceRows(
    collectionFrom([
      invoice({ id: 'a', balance: 125_43, dueAt: daysBeforeNow(20) }),
      invoice({ id: 'b', balance: 899_57, dueAt: daysBeforeNow(10) }),
      invoice({ id: 'c', balance: 40_00, dueAt: daysBeforeNow(5) }),
    ]),
    NO_ORDERS,
    NO_PROJECTS,
    NOW,
  );

  it('sums the ticked balances in integer cents', () => {
    // 125.43 + 899.57 = 1025.00 exactly. In float dollars this is the classic
    // 1024.9999999999999.
    const total = selectedTotal(ROWS, new Set(['a', 'b']));
    expect(total).toBe(1025_00);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('is zero with nothing ticked', () => {
    expect(selectedTotal(ROWS, new Set())).toBe(0);
  });

  it('ignores an id that is not on screen', () => {
    // A stale selection surviving a refresh must not add money to the total
    // for an invoice the contractor can no longer see.
    expect(selectedTotal(ROWS, new Set(['a', 'inv_not_here']))).toBe(125_43);
  });

  it('sums the whole list when everything is ticked', () => {
    expect(selectedTotal(ROWS, new Set(ROWS.map((r) => r.invoice.id)))).toBe(
      125_43 + 899_57 + 40_00,
    );
  });
});
