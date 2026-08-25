// SPDX-License-Identifier: LicenseRef-OpenLBM-Community-Source-1.0
// SPDX-FileCopyrightText: 2026 FutureBuild, Inc. and OpenLBM contributors
import type { EntityId } from '../lib/ids';
import type { Cents } from '../lib/money';
import type { IsoDateTime } from '../lib/time';

/**
 * Artifacts that live on the supplier's side of the counter: the quote their
 * desk produces, the sales order their warehouse picks, the invoice their AR
 * department raises.
 *
 * The contractor doesn't create these — they're what comes back. Which is why
 * an order's `quoteId` / `salesOrderId` / `invoiceId` are set by the simulator,
 * never by a UI action.
 */

export type QuoteStatus = 'submitted' | 'in-review' | 'priced' | 'expired' | 'withdrawn';

export interface Quote {
  id: EntityId;
  orderId: EntityId;
  number: string; // Q-1001
  status: QuoteStatus;
  submittedAt: IsoDateTime;
  pricedAt?: IsoDateTime;
  expiresAt?: IsoDateTime;
  /** Written by the desk — the human touch that makes a quote feel answered. */
  deskNote?: string;
  /** Prices the desk put on lines the ERP couldn't price. */
  linePrices: { scopeItemId: EntityId; unitPrice: Cents; leadTimeDays: number }[];

  /**
   * The SUPPLIER's own id for this quote, when a real one exists.
   *
   * Absent for a simulator quote — the sim's desk is in-process and its quote
   * has no other identity. Present on the wired path, and it is what
   * accept/decline and the price read-back address; without it the portal
   * would have to match a dealer's quote by number, which is a display string.
   *
   * Its presence is also the honest test for "did this actually reach a
   * dealer": a quote with no `supplierRef` was never sent anywhere.
   */
  supplierRef?: string;

  /**
   * The supplier's own state word for the quote — `gable`'s portal vocabulary
   * (REQUESTED / PRICED / ACCEPTED / DECLINED / EXPIRED), carried verbatim.
   *
   * The five-value `QuoteStatus` above is the portal's own flow and is coarser:
   * ACCEPTED and PRICED both land on `priced` because the portal has no
   * accepted state. Keeping the raw word means a contractor comparing the
   * screen with a phone call to the yard hears the same vocabulary, and a
   * consumer can de-duplicate on what the dealer SAID rather than on what the
   * portal rounded it to.
   */
  supplierState?: string;
}

export type SalesOrderStatus =
  | 'submitted'
  | 'confirmed'
  | 'picking'
  | 'ready-willcall'
  | 'out-for-delivery'
  | 'delivered'
  | 'invoiced'
  | 'cancelled';

export const SALES_ORDER_FLOW: readonly SalesOrderStatus[] = [
  'submitted',
  'confirmed',
  'picking',
  'out-for-delivery',
  'delivered',
  'invoiced',
] as const;

export const SALES_ORDER_LABELS: Record<SalesOrderStatus, string> = {
  submitted: 'Submitted',
  confirmed: 'Confirmed',
  picking: 'Being picked',
  'ready-willcall': 'Ready for pickup',
  'out-for-delivery': 'Out for delivery',
  delivered: 'Delivered',
  invoiced: 'Invoiced',
  cancelled: 'Cancelled',
};

export interface TrackingEvent {
  at: IsoDateTime;
  status: SalesOrderStatus;
  note: string;
}

export interface SalesOrder {
  id: EntityId;
  orderId: EntityId;
  number: string; // SO-5001
  status: SalesOrderStatus;
  fulfillment: 'delivery' | 'willcall';
  submittedAt: IsoDateTime;
  /** What the supplier committed to, which may differ from what was asked. */
  promisedDate?: IsoDateTime;
  deliveredAt?: IsoDateTime;
  subtotal: Cents;
  tracking: TrackingEvent[];
}

export interface Invoice {
  id: EntityId;
  number: string; // INV-9001
  accountId: EntityId;
  /** Absent for a counter sale that never went through the portal. */
  orderId?: EntityId;
  salesOrderId?: EntityId;
  origin: 'portal' | 'counter';
  issuedAt: IsoDateTime;
  dueAt: IsoDateTime;
  subtotal: Cents;
  balance: Cents;
  description: string;
}

export function isOpen(invoice: Invoice): boolean {
  return invoice.balance > 0;
}
