// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot, getContext } from '../../boot';
import { computeQuoteTotals } from '../../domain/customer-quote';
import { catalogStore, customerQuotesStore } from '../../stores/root';
import { listOf } from '../../stores/store';
import {
  acceptCustomerQuote,
  addLaborLine,
  buildCustomerQuote,
  quoteForOrder,
  recordQuoteView,
  requestQuoteChanges,
  sendCustomerQuote,
  supplierPriceHorizon,
  updateCustomerQuote,
} from '../customer-quote';
import { moveOrderToStage } from '../orders';

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

const MILLER_DECK = 'ord_miller_deck'; // decking (a selection) + a special-order rail kit
const MILLER_FRAME = 'ord_miller_frame'; // all commodity framing

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

/**
 * Routes an order through the quote desk so its special-order lines carry a
 * dealer price. A customer quote refuses to build over an unpriced line — a $0
 * rail kit on a signed proposal would be the contractor's loss — so tests that
 * quote the deck order must first do what a contractor would.
 */
function priceThroughDesk(orderId: string) {
  const moved = moveOrderToStage(orderId, 'quote');
  if (!moved.ok) throw new Error(moved.error);
  const { control } = getContext().sim;
  control.skipToNextEvent(); // desk acknowledges
  control.skipToNextEvent(); // desk prices
  const back = moveOrderToStage(orderId, 'plan');
  if (!back.ok) throw new Error(back.error);
}

function build(orderId: string) {
  if (orderId === MILLER_DECK) priceThroughDesk(orderId);
  const result = buildCustomerQuote(orderId);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function send(quoteId: string) {
  const result = sendCustomerQuote(quoteId);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('what the customer sees', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('separates selections from commodities', () => {
    const quote = build(MILLER_DECK);

    const selections = quote.lines.filter((l) => l.presentation === 'selection');
    const commodities = quote.lines.filter((l) => l.presentation === 'commodity');

    // Composite decking is something a homeowner chose.
    expect(selections.length).toBeGreaterThan(0);
    expect(selections.some((l) => l.name.toLowerCase().includes('everdeck'))).toBe(true);
    // And the framing order is all commodity — nobody picks a joist.
    expect(build(MILLER_FRAME).lines.every((l) => l.presentation === 'commodity')).toBe(true);
    expect(commodities.length + selections.length).toBe(quote.lines.length);
  });

  it('gives selections a product narrative and commodities none', () => {
    const quote = build(MILLER_DECK);

    for (const line of quote.lines) {
      // A special-order line is a selection but has no catalog entry to draw
      // imagery from — the dealer is sourcing it.
      if (line.presentation === 'selection' && line.productId) {
        // Something to look at and read — that is the entire point.
        expect(line.imageUrl ?? line.description).toBeTruthy();
      } else if (line.presentation === 'commodity') {
        expect(line.imageUrl).toBeUndefined();
        expect(line.description).toBeUndefined();
        expect(line.specs).toBeUndefined();
      }
    }
  });

  it('treats a special-order item as a selection — nobody special-orders a stud', () => {
    const quote = build(MILLER_DECK);
    const special = quote.lines.find((l) => l.sku?.startsWith('SO-'));
    expect(special?.presentation).toBe('selection');
  });

  it('classifies visible finishes as selections and buried structure as commodity', () => {
    const products = catalogStore.get().products;
    const bySku = (sku: string) => products.find((p) => p.sku === sku);

    expect(bySku('DECK-EVRD-CLM-12')?.presentation).toBe('selection');
    expect(bySku('LBR-2X4-8-DF')?.presentation).toBe('commodity');
    expect(bySku('PLY-OSB-7/16-4X8')?.presentation).toBe('commodity');
    // Roofing felt mentions 'roofing' but is buried — buried must win.
    expect(bySku('RF-FELT-15')?.presentation).toBe('commodity');
  });
});

describe('margin', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('marks material up and reports the contractor’s margin', () => {
    const quote = build(MILLER_FRAME);
    updateCustomerQuote(quote.id, { markupPercent: 25 });

    const current = quoteForOrder(MILLER_FRAME);
    if (!current) throw new Error('missing quote');
    const totals = computeQuoteTotals(current);

    expect(totals.markup).toBe(Math.round(totals.materialCost * 0.25));
    expect(totals.grand).toBeGreaterThan(totals.materialCost);
    expect(totals.margin).toBe(totals.grand - totals.materialCost);
  });

  it('includes labor in the total and the margin', () => {
    const quote = build(MILLER_FRAME);
    const before = computeQuoteTotals(quote).grand;

    addLaborLine(quote.id, { description: 'Framing crew', rateType: 'flat', rate: 250_000 });

    const after = quoteForOrder(MILLER_FRAME);
    if (!after) throw new Error('missing quote');
    const totals = computeQuoteTotals(after);

    expect(totals.labor).toBe(250_000);
    expect(totals.grand).toBe(before + 250_000);
  });
});

describe('expiration', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('caps the customer quote at the supplier’s price horizon', () => {
    // Get real quoted pricing (with an expiry) onto the order first.
    moveOrderToStage(MILLER_DECK, 'quote');
    getContext().sim.control.skipToNextEvent();
    getContext().sim.control.skipToNextEvent();
    moveOrderToStage(MILLER_DECK, 'plan');

    const horizon = supplierPriceHorizon(MILLER_DECK);
    expect(horizon).toBeTruthy();

    const quote = build(MILLER_DECK);
    // A contractor must not promise longer than the dealer is holding.
    expect(new Date(quote.validUntil).getTime()).toBeLessThanOrEqual(
      new Date(horizon as string).getTime(),
    );
  });

  it('refuses to extend validity past the supplier horizon', () => {
    moveOrderToStage(MILLER_DECK, 'quote');
    getContext().sim.control.skipToNextEvent();
    getContext().sim.control.skipToNextEvent();
    moveOrderToStage(MILLER_DECK, 'plan');

    const quote = build(MILLER_DECK);
    const horizon = supplierPriceHorizon(MILLER_DECK) as string;

    const farFuture = new Date(new Date(horizon).getTime() + 90 * 86_400_000).toISOString();
    const result = updateCustomerQuote(quote.id, { validUntil: farFuture });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.validUntil).toBe(horizon);
  });

  it('gives a default window when nothing has a supplier expiry', () => {
    // All-ERP pricing: the dealer holds it, so only the contractor's own window applies.
    const quote = build(MILLER_FRAME);
    expect(supplierPriceHorizon(MILLER_FRAME)).toBeUndefined();
    expect(new Date(quote.validUntil).getTime()).toBeGreaterThan(
      new Date(getContext().clock.nowIso()).getTime(),
    );
  });

  it('blocks acceptance once the offer has lapsed', () => {
    const quote = build(MILLER_FRAME);
    const sent = send(quote.id);

    getContext().sim.control.advanceDays(30);

    const result = acceptCustomerQuote({
      token: sent.shareToken as string,
      signedName: 'Dana Miller',
      signatureDataUrl: SIGNATURE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('expired');
  });
});

describe('sending and signing', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('requires a customer name before sending', () => {
    const quote = build(MILLER_FRAME);
    updateCustomerQuote(quote.id, { customer: { name: '' } });

    const result = sendCustomerQuote(quote.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('name');
  });

  it('mints a share token and rotates it on re-send', () => {
    const quote = build(MILLER_FRAME);
    const first = send(quote.id);
    expect(first.shareToken).toBeTruthy();

    const second = send(quote.id);
    // The old link must die, or a superseded proposal stays acceptable.
    expect(second.shareToken).not.toBe(first.shareToken);
  });

  it('records a view without inflating on the first open', () => {
    const sent = send(build(MILLER_FRAME).id);
    recordQuoteView(sent.shareToken as string);

    const quote = quoteForOrder(MILLER_FRAME);
    expect(quote?.status).toBe('viewed');
    expect(quote?.viewCount).toBe(1);
    expect(quote?.firstViewedAt).toBeTruthy();
  });

  it('will not accept without a typed legal name', () => {
    const sent = send(build(MILLER_FRAME).id);

    const result = acceptCustomerQuote({
      token: sent.shareToken as string,
      signedName: ' ',
      signatureDataUrl: SIGNATURE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('legal name');
  });

  it('will not accept without a signature', () => {
    const sent = send(build(MILLER_FRAME).id);

    const result = acceptCustomerQuote({
      token: sent.shareToken as string,
      signedName: 'Dana Miller',
      signatureDataUrl: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('sign');
  });

  it('captures a complete signed record, not just a flag', () => {
    const sent = send(build(MILLER_FRAME).id);
    const total = computeQuoteTotals(sent).grand;

    const result = acceptCustomerQuote({
      token: sent.shareToken as string,
      signedName: 'Dana Miller',
      signatureDataUrl: SIGNATURE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const acceptance = result.value.acceptance;
    expect(acceptance?.signedName).toBe('Dana Miller');
    expect(acceptance?.signatureDataUrl).toBe(SIGNATURE);
    // The exact wording agreed to, and the number agreed to, both frozen —
    // this is what the contractor would have to stand behind later.
    expect(acceptance?.consentText).toContain('electronically');
    expect(acceptance?.acceptedTotal).toBe(total);
    expect(result.value.status).toBe('accepted');
  });

  it('refuses a second acceptance', () => {
    const sent = send(build(MILLER_FRAME).id);
    const token = sent.shareToken as string;

    acceptCustomerQuote({ token, signedName: 'Dana Miller', signatureDataUrl: SIGNATURE });
    const second = acceptCustomerQuote({
      token,
      signedName: 'Someone Else',
      signatureDataUrl: SIGNATURE,
    });

    expect(second.ok).toBe(false);
  });

  it('freezes an accepted quote against further edits', () => {
    const sent = send(build(MILLER_FRAME).id);
    acceptCustomerQuote({
      token: sent.shareToken as string,
      signedName: 'Dana Miller',
      signatureDataUrl: SIGNATURE,
    });

    const result = updateCustomerQuote(sent.id, { markupPercent: 90 });
    expect(result.ok).toBe(false);
  });

  it('records a change request instead of an acceptance', () => {
    const sent = send(build(MILLER_FRAME).id);
    const result = requestQuoteChanges(sent.shareToken as string, 'Can we use cedar instead?');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('changes-requested');
      expect(result.value.changeRequests[0]?.message).toBe('Can we use cedar instead?');
    }
  });

  it('never leaks the contractor’s cost basis into a sent quote', () => {
    const sent = send(build(MILLER_DECK).id);
    // unitCost exists on the line for math, but no supplier identity travels
    // with the document.
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain('Gable');
    expect(sent.contractor.companyName).toBe('Summit Ridge Builders');
  });
});

describe('quote is frozen at send time', () => {
  beforeEach(() => boot({ reset: true, seed: 20_260_730 }));

  it('snapshots lines so later scope edits do not rewrite a sent proposal', async () => {
    const sent = send(build(MILLER_FRAME).id);
    const lineCount = sent.lines.length;

    const { addCatalogItem } = await import('../scope');
    addCatalogItem({ orderId: MILLER_FRAME, product: 'PT-4X4-8', qty: 5 });

    const stored = listOf(customerQuotesStore.get()).find((q) => q.id === sent.id);
    expect(stored?.lines).toHaveLength(lineCount);
  });
});
