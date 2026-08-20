// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import { type Cents, applyPercent } from '../lib/money';
import type { IsoDateTime } from '../lib/time';
import type { ContractorBranding } from './account';
import type { Uom } from './catalog';
import type { Presentation } from './project';

/**
 * The contractor's proposal to their own customer.
 *
 * This is the sell side, and it is a different document from anything the
 * supplier produces: the contractor's brand, the contractor's margin, and the
 * homeowner's decisions. Gable Supply's name appears nowhere on it — the
 * contractor's cost is theirs, not their customer's business.
 */

export type CustomerQuoteStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'changes-requested'
  | 'accepted'
  | 'declined'
  | 'expired';

export interface CustomerQuoteLine {
  id: EntityId;
  scopeItemId: EntityId;
  name: string;
  qty: number;
  uom: Uom;
  /** What the contractor pays. Never shown to the customer. */
  unitCost: Cents;
  /**
   * Selections get a product narrative; commodities get a line. A homeowner
   * chose the decking — they did not choose the joist hangers.
   */
  presentation: Presentation;
  /** Populated for selections so the share page can tell a product story. */
  productId?: EntityId;
  sku?: string;
  imageUrl?: string;
  brandName?: string;
  description?: string;
  specs?: { label: string; value: string }[];
  /** Contractor's own words about why this was chosen. */
  note?: string;
}

export interface LaborLine {
  id: EntityId;
  description: string;
  rateType: 'hourly' | 'flat';
  rate: Cents;
  hours?: number;
}

export interface OverheadLine {
  id: EntityId;
  label: string;
  /** Flat amount, or a percentage of the marked-up material subtotal. */
  amountType: 'flat' | 'percent';
  value: number;
}

/**
 * What the customer actually signed.
 *
 * Kept as a record rather than a boolean because "they accepted" is a claim the
 * contractor may one day need to stand behind: who typed their name, what
 * exact wording they agreed to, when, and the mark they drew.
 */
export interface QuoteAcceptance {
  /** Typed legal name — the binding part under e-signature law. */
  signedName: string;
  /** Drawn mark, stored as a data URL. */
  signatureDataUrl: string;
  acceptedAt: IsoDateTime;
  /** The exact sentence shown above the signature, captured verbatim. */
  consentText: string;
  /** Total the customer agreed to, frozen so a later edit can't rewrite it. */
  acceptedTotal: Cents;
}

export interface ChangeRequest {
  id: EntityId;
  message: string;
  createdAt: IsoDateTime;
  resolvedAt?: IsoDateTime;
}

export interface CustomerQuote {
  id: EntityId;
  orderId: EntityId;
  number: string; // CQ-1001
  status: CustomerQuoteStatus;

  markupPercent: number;
  laborLines: LaborLine[];
  overheadLines: OverheadLine[];
  /** Hide per-line prices and show group subtotals — many contractors prefer this. */
  hideLinePrices: boolean;

  /** Snapshot: a sent proposal must not change under the customer. */
  lines: CustomerQuoteLine[];
  contractor: ContractorBranding;
  customer: { name: string; email?: string; phone?: string };

  shareToken?: string;
  /**
   * When the offer lapses. Capped by the supplier pricing underneath it — see
   * `maxValidUntil`.
   */
  validUntil: IsoDateTime;

  createdAt: IsoDateTime;
  sentAt?: IsoDateTime;
  firstViewedAt?: IsoDateTime;
  viewCount: number;
  respondedAt?: IsoDateTime;
  changeRequests: ChangeRequest[];
  acceptance?: QuoteAcceptance;
}

export interface QuoteTotals {
  materialCost: Cents;
  markup: Cents;
  materials: Cents;
  labor: Cents;
  overhead: Cents;
  grand: Cents;
  /** What the contractor makes: everything above their cost. */
  margin: Cents;
  marginPercent: number;
}

export function laborTotal(line: LaborLine): Cents {
  return line.rateType === 'flat' ? line.rate : Math.round(line.rate * (line.hours ?? 0));
}

export function computeQuoteTotals(quote: {
  lines: readonly CustomerQuoteLine[];
  markupPercent: number;
  laborLines: readonly LaborLine[];
  overheadLines: readonly OverheadLine[];
}): QuoteTotals {
  const materialCost = quote.lines.reduce(
    (sum, line) => sum + Math.round(line.unitCost * line.qty),
    0,
  );
  const markup = applyPercent(materialCost, quote.markupPercent);
  const materials = materialCost + markup;
  const labor = quote.laborLines.reduce((sum, line) => sum + laborTotal(line), 0);

  // Percentage overheads are taken on marked-up materials plus labor, which is
  // how a contractor actually computes permits, disposal, and general conditions.
  const overheadBase = materials + labor;
  const overhead = quote.overheadLines.reduce(
    (sum, line) =>
      sum + (line.amountType === 'flat' ? line.value : applyPercent(overheadBase, line.value)),
    0,
  );

  const grand = materials + labor + overhead;
  const margin = grand - materialCost;

  return {
    materialCost,
    markup,
    materials,
    labor,
    overhead,
    grand,
    margin,
    marginPercent: grand > 0 ? Math.round((margin / grand) * 100) : 0,
  };
}

/**
 * The latest date this proposal may be honoured.
 *
 * A contractor must not promise their customer a price for longer than the
 * supplier is holding it — otherwise the day the dealer's quote lapses, the
 * contractor is exposed to the movement on a job they've already sold.
 * `undefined` supplier expiry means everything is ERP-priced, which the dealer
 * holds indefinitely.
 */
export function maxValidUntil(
  supplierPriceExpiresAt: IsoDateTime | undefined,
): IsoDateTime | undefined {
  return supplierPriceExpiresAt;
}

export function isQuoteExpired(quote: CustomerQuote, now: IsoDateTime): boolean {
  return quote.validUntil <= now;
}

/** A customer can only act on a live offer. */
export function canRespond(quote: CustomerQuote, now: IsoDateTime): boolean {
  if (isQuoteExpired(quote, now)) return false;
  return (
    quote.status === 'sent' || quote.status === 'viewed' || quote.status === 'changes-requested'
  );
}

export const CONSENT_TEXT =
  'By typing my name and signing below, I accept this proposal and agree to its scope and price. ' +
  'I consent to signing electronically, and understand this has the same legal effect as a handwritten signature.';
