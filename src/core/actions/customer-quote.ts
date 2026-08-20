// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import { getContext } from '../boot';
import {
  CONSENT_TEXT,
  type CustomerQuote,
  type CustomerQuoteLine,
  type LaborLine,
  type OverheadLine,
  canRespond,
  computeQuoteTotals,
  isQuoteExpired,
} from '../domain/customer-quote';
import { isPriced } from '../domain/project';
import { newId, newShareToken } from '../lib/ids';
import { type Result, err, ok } from '../lib/result';
import { type IsoDateTime, addDays } from '../lib/time';
import {
  activityStore,
  catalogStore,
  customerQuotesStore,
  ordersStore,
  projectsStore,
  scopeStore,
  sessionStore,
} from '../stores/root';
import { listOf, patch, upsert } from '../stores/store';
import { requireCapability } from './team';

/**
 * Building and sending the contractor's proposal to their own customer.
 *
 * The defining constraint: a sent quote is frozen. Its lines, branding, and
 * totals are snapshotted at send time, so a homeowner reading it tomorrow sees
 * exactly what they were sent — not whatever the contractor has since edited.
 */

const DEFAULT_VALID_DAYS = 14;

function nowIso(): IsoDateTime {
  return getContext().clock.nowIso();
}

function log(kind: string, message: string, orderId?: string, actor: 'user' | 'system' = 'user') {
  const state = activityStore.get();
  activityStore.set({
    ...state,
    entries: [
      { id: newId('act'), at: nowIso(), actor, kind, message, ...(orderId ? { orderId } : {}) },
      ...state.entries,
    ].slice(0, 400),
  });
}

export function quoteForOrder(orderId: string): CustomerQuote | undefined {
  return listOf(customerQuotesStore.get()).find((quote) => quote.orderId === orderId);
}

export function quoteByToken(token: string): CustomerQuote | undefined {
  return listOf(customerQuotesStore.get()).find((quote) => quote.shareToken === token);
}

/**
 * The earliest supplier price expiry across the order's lines.
 *
 * This caps how long the contractor may hold their own offer open. Promising a
 * homeowner 30 days on materials the dealer only holds for 14 puts the movement
 * squarely on the contractor.
 */
export function supplierPriceHorizon(orderId: string): IsoDateTime | undefined {
  const expiries = listOf(scopeStore.get())
    .filter((item) => item.orderId === orderId && item.priceExpiresAt !== undefined)
    .map((item) => item.priceExpiresAt as IsoDateTime)
    .sort();
  return expiries[0];
}

/**
 * Lines the dealer is not currently standing behind — never priced, or priced
 * and lapsed. A customer quote must refuse to include them: `unitCost ?? 0`
 * would put a custom door on a homeowner's signed proposal at $0, and the
 * contractor would eat the real cost after acceptance froze the total.
 */
function unpricedLines(orderId: string): string[] {
  const now = nowIso();
  return listOf(scopeStore.get())
    .filter((item) => item.orderId === orderId && !isPriced(item, now))
    .map((item) => item.snapshot.name);
}

function refuseUnpriced(names: string[]): string {
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
  return `${shown}${more} ${names.length === 1 ? 'has' : 'have'} no dealer price yet. Send this order through the quote desk before quoting your customer — a proposal with a $0 line is a promise you'd have to eat.`;
}

function buildLines(orderId: string): CustomerQuoteLine[] {
  const { products } = catalogStore.get();
  const productById = new Map(products.map((product) => [product.id, product]));

  return listOf(scopeStore.get())
    .filter((item) => item.orderId === orderId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => {
      const product = item.productId ? productById.get(item.productId) : undefined;
      // A special-order item is by definition something the customer picked —
      // nobody special-orders a stud.
      const presentation = product?.presentation ?? 'selection';

      return {
        id: newId('cql'),
        scopeItemId: item.id,
        name: item.snapshot.name,
        qty: item.qty,
        uom: item.uom,
        unitCost: item.unitPrice ?? 0,
        presentation,
        ...(item.productId ? { productId: item.productId } : {}),
        ...(item.snapshot.sku ? { sku: item.snapshot.sku } : {}),
        // Only selections carry the imagery and narrative — commodities would
        // just be noise on a homeowner's proposal.
        ...(presentation === 'selection' && item.snapshot.imageUrl
          ? { imageUrl: item.snapshot.imageUrl }
          : {}),
        ...(presentation === 'selection' && product?.description
          ? { description: product.description }
          : {}),
        ...(presentation === 'selection' && product?.specs?.length ? { specs: product.specs } : {}),
        ...(item.notes ? { note: item.notes } : {}),
      } satisfies CustomerQuoteLine;
    });
}

export function buildCustomerQuote(orderId: string): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const order = ordersStore.get().byId[orderId];
  if (!order) return err('That order no longer exists.');

  const project = projectsStore.get().byId[order.projectId];
  const account = sessionStore.get().account;
  if (!account) return err('No account is signed in.');

  const existing = quoteForOrder(orderId);
  if (existing && existing.status !== 'draft') {
    return err(`${existing.number} has already been sent. Revise it to make changes.`);
  }

  const lines = buildLines(orderId);
  if (lines.length === 0) return err('Add materials to this order before building a quote.');

  const unpriced = unpricedLines(orderId);
  if (unpriced.length > 0) return err(refuseUnpriced(unpriced));

  const now = nowIso();
  const horizon = supplierPriceHorizon(orderId);
  const requested = addDays(now, DEFAULT_VALID_DAYS);
  // Never outlive the supplier's pricing.
  const validUntil = horizon !== undefined && horizon < requested ? horizon : requested;

  const quote: CustomerQuote = {
    id: existing?.id ?? newId('cq'),
    orderId,
    number: existing?.number ?? `CQ-${1000 + listOf(customerQuotesStore.get()).length + 1}`,
    status: 'draft',
    markupPercent: existing?.markupPercent ?? 22,
    laborLines: existing?.laborLines ?? [],
    overheadLines: existing?.overheadLines ?? [],
    hideLinePrices: existing?.hideLinePrices ?? false,
    lines,
    contractor: account.branding,
    customer: existing?.customer ?? { name: project?.clientName ?? '' },
    validUntil,
    createdAt: existing?.createdAt ?? now,
    viewCount: 0,
    changeRequests: [],
  };

  customerQuotesStore.set(upsert(customerQuotesStore.get(), quote));
  return ok(quote);
}

export interface UpdateQuoteInput {
  markupPercent?: number;
  hideLinePrices?: boolean;
  customer?: { name: string; email?: string; phone?: string };
  validUntil?: IsoDateTime;
}

export function updateCustomerQuote(
  quoteId: string,
  changes: UpdateQuoteInput,
): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const quote = customerQuotesStore.get().byId[quoteId];
  if (!quote) return err('That quote no longer exists.');
  if (quote.status === 'accepted')
    return err('This quote has been accepted and cannot be changed.');
  if (quote.status !== 'draft') {
    return err(
      `${quote.number} has already been sent — the live link must show exactly what was sent. Revise it to make changes; revising takes the old link down.`,
    );
  }

  // Re-apply the cap: a contractor cannot extend past the supplier's horizon.
  let validUntil = changes.validUntil ?? quote.validUntil;
  const horizon = supplierPriceHorizon(quote.orderId);
  if (horizon !== undefined && validUntil > horizon) validUntil = horizon;

  const updated: CustomerQuote = { ...quote, ...changes, validUntil };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  return ok(updated);
}

/**
 * Money-bearing edits are legal only on a draft. A 'sent' quote is live under
 * a homeowner's link, and an 'accepted' one is signed — editing either from
 * the studio would change a number someone else already relied on.
 */
function editableDraft(quoteId: string): Result<CustomerQuote> {
  const quote = customerQuotesStore.get().byId[quoteId];
  if (!quote) return err('That quote no longer exists.');
  if (quote.status === 'accepted')
    return err('This quote has been accepted and cannot be changed.');
  if (quote.status !== 'draft') {
    return err(
      `${quote.number} has already been sent — revise it to make changes. Revising takes the old link down.`,
    );
  }
  return ok(quote);
}

export function addLaborLine(quoteId: string, line: Omit<LaborLine, 'id'>): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const editable = editableDraft(quoteId);
  if (!editable.ok) return editable;
  const quote = editable.value;

  const updated = { ...quote, laborLines: [...quote.laborLines, { ...line, id: newId('lab') }] };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  return ok(updated);
}

export function removeLaborLine(quoteId: string, lineId: string): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const editable = editableDraft(quoteId);
  if (!editable.ok) return editable;
  const quote = editable.value;

  const updated = { ...quote, laborLines: quote.laborLines.filter((l) => l.id !== lineId) };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  return ok(updated);
}

export function addOverheadLine(
  quoteId: string,
  line: Omit<OverheadLine, 'id'>,
): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const editable = editableDraft(quoteId);
  if (!editable.ok) return editable;
  const quote = editable.value;

  const updated = {
    ...quote,
    overheadLines: [...quote.overheadLines, { ...line, id: newId('ovh') }],
  };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  return ok(updated);
}

export function removeOverheadLine(quoteId: string, lineId: string): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const editable = editableDraft(quoteId);
  if (!editable.ok) return editable;
  const quote = editable.value;

  const updated = { ...quote, overheadLines: quote.overheadLines.filter((l) => l.id !== lineId) };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  return ok(updated);
}

/** Freezes the quote and mints a share link. */
export function sendCustomerQuote(quoteId: string): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const quote = customerQuotesStore.get().byId[quoteId];
  if (!quote) return err('That quote no longer exists.');
  if (!quote.customer.name.trim()) return err("Add your customer's name before sending.");
  if (quote.status === 'accepted') return err('This quote has already been accepted.');

  const unpriced = unpricedLines(quote.orderId);
  if (unpriced.length > 0) return err(refuseUnpriced(unpriced));

  const now = nowIso();
  if (quote.validUntil <= now) {
    return err('This quote has already expired. Rebuild it to get fresh pricing.');
  }

  // Re-snapshot the lines so what was sent is exactly what was on the order at
  // that moment, and rotate the token so any older link goes dead.
  const updated: CustomerQuote = {
    ...quote,
    lines: buildLines(quote.orderId),
    status: 'sent',
    shareToken: newShareToken(),
    sentAt: now,
    viewCount: 0,
  };

  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));

  const totals = computeQuoteTotals(updated);
  log(
    'customer-quote.sent',
    `Sent ${updated.number} to ${updated.customer.name} — ${(totals.grand / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`,
    quote.orderId,
  );

  return ok(updated);
}

/**
 * Pulls a sent quote back to draft for editing. The token rotates IMMEDIATELY —
 * not at the eventual re-send — because the moment the contractor intends to
 * change the numbers, the old link is showing a proposal they no longer stand
 * behind. A homeowner opening it now gets "link no longer valid" instead of a
 * total that is quietly about to move.
 */
export function reviseCustomerQuote(quoteId: string): Result<CustomerQuote> {
  const gate = requireCapability('customer-quote');
  if (!gate.ok) return gate;

  const quote = customerQuotesStore.get().byId[quoteId];
  if (!quote) return err('That quote no longer exists.');
  if (quote.status === 'accepted')
    return err('This quote has been accepted and cannot be revised.');
  if (quote.status === 'draft') return ok(quote);

  const updated: CustomerQuote = {
    ...quote,
    status: 'draft',
    shareToken: newShareToken(),
  };
  customerQuotesStore.set(patch(customerQuotesStore.get(), quoteId, updated));
  log(
    'customer-quote.revised',
    `Revised ${quote.number} — the previous link is dead`,
    quote.orderId,
  );
  return ok(updated);
}

// --- Customer-side actions, reached only through the share link -------------

export function recordQuoteView(token: string): Result<CustomerQuote> {
  const quote = quoteByToken(token);
  if (!quote) return err('This link is no longer valid.');

  const now = nowIso();
  const updated: CustomerQuote = {
    ...quote,
    viewCount: quote.viewCount + 1,
    ...(quote.firstViewedAt ? {} : { firstViewedAt: now }),
    // Only 'sent' advances to 'viewed'; a responded quote keeps its status.
    ...(quote.status === 'sent' ? { status: 'viewed' as const } : {}),
  };

  customerQuotesStore.set(patch(customerQuotesStore.get(), quote.id, updated));

  if (!quote.firstViewedAt) {
    log(
      'customer-quote.viewed',
      `${quote.customer.name} opened ${quote.number}`,
      quote.orderId,
      'system',
    );
  }
  return ok(updated);
}

export interface AcceptQuoteInput {
  token: string;
  signedName: string;
  signatureDataUrl: string;
}

/**
 * Acceptance requires a signature, deliberately.
 *
 * A bare "Accept" button is a click, not a commitment. Capturing a typed legal
 * name, a drawn mark, the exact consent wording shown, and the total agreed to
 * gives the contractor something they can actually stand behind later — and
 * makes the moment feel as consequential to the homeowner as it is.
 */
export function acceptCustomerQuote(input: AcceptQuoteInput): Result<CustomerQuote> {
  const quote = quoteByToken(input.token);
  if (!quote) return err('This link is no longer valid.');

  const now = nowIso();
  if (isQuoteExpired(quote, now)) {
    return err('This proposal has expired. Please contact your contractor for an updated price.');
  }
  if (!canRespond(quote, now)) {
    return err('This proposal has already been responded to.');
  }

  const signedName = input.signedName.trim();
  if (signedName.length < 2) return err('Please type your full legal name.');
  if (!input.signatureDataUrl) return err('Please sign in the box above.');

  const totals = computeQuoteTotals(quote);

  const updated: CustomerQuote = {
    ...quote,
    status: 'accepted',
    respondedAt: now,
    acceptance: {
      signedName,
      signatureDataUrl: input.signatureDataUrl,
      acceptedAt: now,
      consentText: CONSENT_TEXT,
      acceptedTotal: totals.grand,
    },
  };

  customerQuotesStore.set(patch(customerQuotesStore.get(), quote.id, updated));
  log('customer-quote.accepted', `${signedName} accepted ${quote.number}`, quote.orderId, 'system');

  return ok(updated);
}

export function requestQuoteChanges(token: string, message: string): Result<CustomerQuote> {
  const quote = quoteByToken(token);
  if (!quote) return err('This link is no longer valid.');

  const now = nowIso();
  if (!canRespond(quote, now)) return err('This proposal is no longer open for changes.');
  if (!message.trim()) return err('Tell your contractor what you would like changed.');

  const updated: CustomerQuote = {
    ...quote,
    status: 'changes-requested',
    respondedAt: now,
    changeRequests: [
      ...quote.changeRequests,
      { id: newId('chg'), message: message.trim(), createdAt: now },
    ],
  };

  customerQuotesStore.set(patch(customerQuotesStore.get(), quote.id, updated));
  log(
    'customer-quote.changes',
    `${quote.customer.name} requested changes to ${quote.number}`,
    quote.orderId,
    'system',
  );

  return ok(updated);
}
