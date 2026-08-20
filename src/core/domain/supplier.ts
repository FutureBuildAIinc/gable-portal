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
