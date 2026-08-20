// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { describe, expect, it } from 'vitest';
import type { CustomerQuote, CustomerQuoteLine, LaborLine, OverheadLine } from '../customer-quote';
import {
  CONSENT_TEXT,
  canRespond,
  computeQuoteTotals,
  isQuoteExpired,
  laborTotal,
  maxValidUntil,
} from '../customer-quote';

/**
 * The customer quote is the one document in this product a member of the public
 * signs. Its grand total becomes `QuoteAcceptance.acceptedTotal` — frozen, so a
 * later edit cannot rewrite what somebody agreed to.
 *
 * That makes `computeQuoteTotals` the highest-consequence arithmetic in the
 * codebase, and the ORDER of its operations is the load-bearing part: markup
 * applies to material cost, and percentage overhead applies to marked-up
 * materials PLUS labor. Get that order wrong and every number still looks
 * plausible while the contractor's margin is quietly wrong on every job.
 */

const NOW = '2026-08-20T12:00:00.000Z';

function line(unitCost: number, qty: number, id = `l_${unitCost}_${qty}`): CustomerQuoteLine {
  return {
    id,
    scopeItemId: `si_${id}`,
    name: 'Line',
    qty,
    uom: 'EA',
    unitCost,
    presentation: 'commodity',
  };
}

describe('laborTotal', () => {
  it('takes a flat rate as the whole amount and ignores hours', () => {
    // A flat line with stray hours on it must not be multiplied. Hours are a
    // leftover when someone toggles hourly -> flat in the builder.
    expect(
      laborTotal({ id: 'lb1', description: 'Deck build', rateType: 'flat', rate: 450_000 }),
    ).toBe(450_000);
    expect(
      laborTotal({
        id: 'lb2',
        description: 'Deck build',
        rateType: 'flat',
        rate: 450_000,
        hours: 40,
      }),
    ).toBe(450_000);
  });

  it('multiplies an hourly rate by hours and rounds once', () => {
    // $87.50/hr for 13.5 hours = $1,181.25 -> 118_125 cents exactly.
    expect(
      laborTotal({
        id: 'lb3',
        description: 'Framing',
        rateType: 'hourly',
        rate: 8750,
        hours: 13.5,
      }),
    ).toBe(118_125);
  });

  it('treats an hourly line with no hours as zero, not as its rate', () => {
    // Half-entered rows exist in the builder. Charging a homeowner one hour
    // because nobody typed a number would be a real invoice.
    expect(laborTotal({ id: 'lb4', description: 'TBD', rateType: 'hourly', rate: 9500 })).toBe(0);
  });
});

describe('computeQuoteTotals', () => {
  it('applies markup to material cost, not to labor or overhead', () => {
    const totals = computeQuoteTotals({
      lines: [line(10_000, 3), line(2_500, 4)], // 30_000 + 10_000 = 40_000
      markupPercent: 22,
      laborLines: [{ id: 'lb', description: 'Install', rateType: 'flat', rate: 150_000 }],
      overheadLines: [],
    });

    expect(totals.materialCost).toBe(40_000);
    expect(totals.markup).toBe(8_800); // 22% of 40_000
    expect(totals.materials).toBe(48_800);
    expect(totals.labor).toBe(150_000);
    // Markup is 22% of MATERIALS. If it were taken on materials + labor it
    // would be 41_800, and the grand total would be 33_000 higher.
    expect(totals.grand).toBe(198_800);
  });

  it('takes percentage overhead on marked-up materials PLUS labor', () => {
    const totals = computeQuoteTotals({
      lines: [line(100_000, 1)],
      markupPercent: 20, // markup 20_000 -> materials 120_000
      laborLines: [{ id: 'lb', description: 'Crew', rateType: 'flat', rate: 80_000 }],
      overheadLines: [{ id: 'oh', label: 'General conditions', amountType: 'percent', value: 10 }],
    });

    expect(totals.materials).toBe(120_000);
    expect(totals.labor).toBe(80_000);
    // 10% of (120_000 + 80_000). NOT 10% of 100_000 (10_000) and NOT 10% of
    // 120_000 (12_000) — both of those are plausible-looking wrong answers.
    expect(totals.overhead).toBe(20_000);
    expect(totals.grand).toBe(220_000);
  });

  it('does not compound one percentage overhead onto another', () => {
    const totals = computeQuoteTotals({
      lines: [line(100_000, 1)],
      markupPercent: 0,
      laborLines: [],
      overheadLines: [
        { id: 'oh1', label: 'Permits', amountType: 'percent', value: 10 },
        { id: 'oh2', label: 'Disposal', amountType: 'percent', value: 5 },
      ],
    });

    // Both are taken on the same base of 100_000: 10_000 + 5_000. Compounding
    // would give 10_000 + 5_500 = 15_500.
    expect(totals.overhead).toBe(15_000);
  });

  it('adds flat and percentage overhead lines together', () => {
    const overheadLines: OverheadLine[] = [
      { id: 'oh1', label: 'Dumpster', amountType: 'flat', value: 45_000 },
      { id: 'oh2', label: 'Permits', amountType: 'percent', value: 5 },
    ];

    const totals = computeQuoteTotals({
      lines: [line(200_000, 1)],
      markupPercent: 0,
      laborLines: [],
      overheadLines,
    });

    expect(totals.overhead).toBe(45_000 + 10_000);
    expect(totals.grand).toBe(200_000 + 55_000);
  });

  it('reports margin as everything above the contractor cost, and its percent of the grand total', () => {
    const totals = computeQuoteTotals({
      lines: [line(100_000, 1)],
      markupPercent: 25, // 25_000
      laborLines: [{ id: 'lb', description: 'Install', rateType: 'flat', rate: 75_000 }],
      overheadLines: [],
    });

    expect(totals.grand).toBe(200_000);
    // Margin is grand - materialCost: the markup AND the labor, because labor
    // is the contractor's own time, not a cost they paid the dealer.
    expect(totals.margin).toBe(100_000);
    // Percent OF THE GRAND TOTAL (what the customer pays), not of cost.
    // Of cost it would read 100%.
    expect(totals.marginPercent).toBe(50);
  });

  it('reports 0% margin rather than dividing by zero on an empty quote', () => {
    const empty = computeQuoteTotals({
      lines: [],
      markupPercent: 30,
      laborLines: [],
      overheadLines: [],
    });

    expect(empty.grand).toBe(0);
    expect(empty.marginPercent).toBe(0);
    expect(Number.isNaN(empty.marginPercent)).toBe(false);
  });

  it('keeps every component an integer number of cents', () => {
    // 17.5% of an odd cost, with a fractional quantity, is where fractions of a
    // cent would appear if any step forgot to round.
    const totals = computeQuoteTotals({
      lines: [line(1_733, 7.5)], // 12_997.5 -> 12_998
      markupPercent: 17.5,
      laborLines: [{ id: 'lb', description: 'Trim', rateType: 'hourly', rate: 7_250, hours: 3.25 }],
      overheadLines: [{ id: 'oh', label: 'Fuel', amountType: 'percent', value: 3.5 }],
    });

    for (const [key, value] of Object.entries(totals)) {
      if (key === 'marginPercent') continue;
      expect(Number.isInteger(value), `${key} = ${value}`).toBe(true);
    }

    expect(totals.materialCost).toBe(12_998); // round(1733 * 7.5)
    expect(totals.markup).toBe(2_275); // round(12_998 * 0.175) = 2274.65
    expect(totals.materials).toBe(15_273);
    expect(totals.labor).toBe(23_563); // round(7_250 * 3.25) = 23562.5
    expect(totals.overhead).toBe(1_359); // round((15_273 + 23_563) * 0.035) = 1359.26
    expect(totals.grand).toBe(15_273 + 23_563 + 1_359);
  });

  it('does not fold the contractor cost into anything the customer sees', () => {
    // `unitCost` is what the contractor pays the dealer. It appears in
    // materialCost and in margin, and nowhere else — the customer's number is
    // `materials`, which is cost + markup.
    const totals = computeQuoteTotals({
      lines: [line(50_000, 1)],
      markupPercent: 40,
      laborLines: [],
      overheadLines: [],
    });

    expect(totals.materialCost).toBe(50_000);
    expect(totals.materials).toBe(70_000);
    expect(totals.grand).toBe(70_000);
    expect(totals.margin).toBe(20_000);
  });
});

describe('quote validity', () => {
  /**
   * A contractor must not promise their customer a price for longer than the
   * dealer is holding it, or the day the dealer's quote lapses they are exposed
   * to the movement on a job they have already sold.
   */
  it('caps the offer at the supplier price expiry when there is one', () => {
    expect(maxValidUntil('2026-09-01T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('imposes no cap when everything is ERP-priced', () => {
    // No desk-quoted line means no expiry to inherit; the dealer holds ERP
    // prices indefinitely.
    expect(maxValidUntil(undefined)).toBeUndefined();
  });

  it('treats the expiry instant itself as expired', () => {
    // `<=`, not `<`. An offer that is "valid until noon" is not valid at noon.
    expect(isQuoteExpired(quote({ validUntil: NOW }), NOW)).toBe(true);
    expect(isQuoteExpired(quote({ validUntil: '2026-08-20T12:00:00.001Z' }), NOW)).toBe(false);
  });
});

describe('canRespond', () => {
  it('lets a customer act on a live offer they have been sent', () => {
    for (const status of ['sent', 'viewed', 'changes-requested'] as const) {
      expect(canRespond(quote({ status }), NOW), status).toBe(true);
    }
  });

  it('refuses a draft, and refuses one already answered', () => {
    for (const status of ['draft', 'accepted', 'declined', 'expired'] as const) {
      expect(canRespond(quote({ status }), NOW), status).toBe(false);
    }
  });

  it('refuses an expired offer regardless of status', () => {
    const lapsed = quote({ status: 'sent', validUntil: '2026-08-19T00:00:00.000Z' });
    expect(lapsed.status).toBe('sent');
    expect(canRespond(lapsed, NOW)).toBe(false);
  });
});

describe('CONSENT_TEXT', () => {
  it('states both the agreement and the e-signature effect', () => {
    // Captured verbatim into QuoteAcceptance.consentText, because "they
    // accepted" is a claim the contractor may have to stand behind. If this
    // string changes, previously-signed quotes keep the wording they were
    // shown — this test is here so a change to it is a deliberate act.
    expect(CONSENT_TEXT).toContain('accept this proposal');
    expect(CONSENT_TEXT).toContain('scope and price');
    expect(CONSENT_TEXT).toContain('signing electronically');
    expect(CONSENT_TEXT).toContain('same legal effect as a handwritten signature');
  });
});

function quote(overrides: Partial<CustomerQuote> = {}): CustomerQuote {
  const laborLines: LaborLine[] = [];
  return {
    id: 'cq_1',
    orderId: 'ord_1',
    number: 'CQ-1001',
    status: 'sent',
    markupPercent: 20,
    laborLines,
    overheadLines: [],
    hideLinePrices: false,
    lines: [],
    contractor: { companyName: 'Summit Ridge Builders' } as CustomerQuote['contractor'],
    customer: { name: 'A. Homeowner' },
    validUntil: '2026-09-30T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    viewCount: 0,
    changeRequests: [],
    ...overrides,
  };
}
